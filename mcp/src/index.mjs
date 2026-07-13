#!/usr/bin/env node
// Hanji MCP server — exposes the local workspace (pages, blocks, search)
// to AI agents over stdio. Talks to the EdgeBase backend via its REST API.

import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { eb, blockToMarkdown, blocksToMarkdown, markdownToBlocks } from "./edgebase.mjs";
import { hanjiEnv } from "./legacy-product-compat.mjs";

const server = new McpServer({
  name: "hanji",
  version: "0.1.0",
});

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
  for (const name of names) server.registerTool(name, definition, handler);
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
      "Notion MCP-compatible Markdown subset supported by Hanji. Hanji does not provide a separate Notion AI layer.",
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
        "",
        "Hanji intentionally does not claim support for Notion AI-only or connected-source syntax. If a Notion MCP workflow asks for Notion AI behavior, Hanji tools keep the call shape compatible but search only Hanji product data.",
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
        "Supported view types: table, board, list, gallery, calendar, timeline.",
        "Unsupported Notion-only/AI-adjacent or not-yet-productized view types are rejected explicitly: form, chart, map, dashboard.",
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
        "- `COVER \"Property\"` sets board/gallery cover property.",
        "- `WRAP CELLS` and `NO WRAP` toggle wrapping.",
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
        "Last reviewed: 2026-07-12 against MCP authorization 2025-11-25 and MCP tools 2025-06-18.",
        "",
        "- Transport: this package provides local stdio with credentials read from environment variables; Hanji also exposes a hosted Streamable HTTP-compatible JSON-RPC endpoint.",
        "- Hosted authorization: OAuth authorization-code + PKCE, protected-resource metadata, audience validation, scoped Hanji grants, and no bearer-token passthrough are implemented and smoke-tested.",
        "- Tool results: structured MCP results and output schemas are used for policy, workspace, database description, and database query tools.",
        "- Access control: every call stays on the Hanji product API, authenticates as the configured user or service principal, then applies optional read-only, allowlist, validity-window, and scope narrowing.",
        "- Auditability: mutating product-API calls record `mcp.client_action` organization audit events with client and provisioned subject metadata when a workspace can be resolved.",
        "- Notion MCP compatibility: official-style tool aliases are exposed where Hanji has product-backed behavior. Notion AI-only, connected-source, and meeting-notes features return explicit fallback or unsupported responses instead of pretending to exist.",
        "- Remote hosted MCP: the current hosted subset supports read/query, comments, duplicate/move, and database-view operations. Primary Notion-compatible page/database create and update calls validate scopes but fail closed until they use Hanji's canonical stored-file lifecycle.",
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
/** @type {[string, ...string[]]} */
const ROLLUP_FUNCTIONS = [
  "show_original",
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

function optionName(prop, id) {
  const option = (prop.config?.options ?? []).find((item) => String(item.id) === String(id));
  return option?.name ?? String(id ?? "");
}

function optionId(prop, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const option = (prop.config?.options ?? []).find(
    (item) => String(item.id) === raw || item.name.toLowerCase() === raw.toLowerCase()
  );
  return option?.id ?? raw;
}

function ids(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return [String(value)];
}

function valueIsPresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== "";
}

function rollupPercent(count, total) {
  if (!total) return "0%";
  return `${compactNumber((count / total) * 100)}%`;
}

function rollupValuePieces(value) {
  if (Array.isArray(value)) return value.flatMap(rollupValuePieces);
  if (!valueIsPresent(value)) return [];
  if (typeof value === "object") return [JSON.stringify(value)];
  return [String(value)];
}

function rollupCheckedValue(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "checked"].includes(value.trim().toLowerCase());
}

function rollupDateValues(value) {
  if (Array.isArray(value)) return value.flatMap(rollupDateValues);
  if (!value) return [];
  if (typeof value === "object") {
    return [value.start, value.end].flatMap(rollupDateValues);
  }
  return String(value)
    .split("/")
    .map((part) => formulaDate(part))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
}

function personIds(value) {
  if (Array.isArray(value)) return value.flatMap((item) => personIds(item)).filter(Boolean);
  if (!value) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value !== "object") return [];
  const id = value.id ?? value.userId;
  return typeof id === "string" && id.trim() ? [id.trim()] : [];
}

function personLabel(id) {
  return id ? "You" : "";
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function formatNumberValue(value, format = "number") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (format === "number") return compactNumber(n);
  // MCP's protocol default is English; do not inherit the daemon host locale.
  if (format === "comma") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(n);
  if (format === "percent") {
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      maximumFractionDigits: 2,
    }).format(n / 100);
  }
  if (format === "won") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "KRW",
      maximumFractionDigits: 0,
    }).format(n);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: format === "euro" ? "EUR" : "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function tokenizeFormula(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      let value = "";
      i += 1;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ type: "string", value });
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let value = ch;
      i += 1;
      while (i < input.length && /[0-9.]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ type: "number", value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = ch;
      i += 1;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ type: "identifier", value });
      continue;
    }
    const two = input.slice(i, i + 2);
    if ([">=", "<=", "==", "!="].includes(two)) {
      tokens.push({ type: "operator", value: two });
      i += 2;
      continue;
    }
    if ("+-*/%^><".includes(ch)) {
      tokens.push({ type: "operator", value: ch });
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i += 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function formulaToNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function formulaToText(value) {
  if (value == null) return "";
  return String(value);
}

function formulaToBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return value !== null && value !== "";
}

function formulaNumbers(values) {
  return values.map((value) => formulaToNumber(value));
}

function formulaMedian(values) {
  const numbers = formulaNumbers(values).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function formulaRound(value, precisionValue) {
  const precision = Math.trunc(formulaToNumber(precisionValue ?? 0));
  const factor = Math.pow(10, precision);
  if (!Number.isFinite(factor) || factor === 0) return Math.round(formulaToNumber(value ?? null));
  return Math.round(formulaToNumber(value ?? null) * factor) / factor;
}

function formulaIndex(value) {
  return Math.max(0, Math.trunc(formulaToNumber(value ?? 0)));
}

function formulaSubstring(value, start, end) {
  const text = formulaToText(value ?? "");
  const from = formulaIndex(start);
  if (end === undefined || end === null || end === "") return text.slice(from);
  return text.slice(from, Math.max(from, formulaIndex(end)));
}

function formulaRepeat(value, countValue) {
  const count = Math.max(0, Math.min(1000, Math.trunc(formulaToNumber(countValue ?? 0))));
  return formulaToText(value ?? "").repeat(count).slice(0, 10000);
}

// Workspace-authored formula patterns are compiled into RegExp and run per row
// per query. Cap pattern/subject sizes and treat oversized or invalid patterns
// as literal text so a hostile pattern cannot pin the event loop with
// catastrophic backtracking on big inputs. (True ReDoS-proofing needs an
// RE2-class engine and is out of scope for this cheap mitigation.)
const FORMULA_REGEX_MAX_PATTERN_LENGTH = 256;
const FORMULA_REGEX_MAX_SUBJECT_LENGTH = 10_000;

function formulaRegExp(pattern, flags, subjectLength) {
  if (pattern.length > FORMULA_REGEX_MAX_PATTERN_LENGTH) return null;
  if (subjectLength > FORMULA_REGEX_MAX_SUBJECT_LENGTH) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function formulaReplace(value, patternValue, replacementValue, all = false) {
  const text = formulaToText(value ?? "");
  const pattern = formulaToText(patternValue ?? "");
  const replacement = formulaToText(replacementValue ?? "");
  if (!pattern) return text;
  const regex = formulaRegExp(pattern, all ? "g" : "", text.length);
  if (regex) return text.replace(regex, replacement);
  return all ? text.split(pattern).join(replacement) : text.replace(pattern, replacement);
}

export function formulaTest(value, patternValue) {
  const pattern = formulaToText(patternValue ?? "");
  if (!pattern) return false;
  const text = formulaToText(value ?? "");
  const regex = formulaRegExp(pattern, "", text.length);
  return regex ? regex.test(text) : text.includes(pattern);
}

export function formulaDate(value) {
  const raw = formulaToText(value ?? "").split("/")[0].trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(Date.UTC(
      year,
      month,
      day,
      Number(match[4] ?? 0),
      Number(match[5] ?? 0),
      Number(match[6] ?? 0),
    ));
    if (Number.isNaN(date.getTime())) return null;
    // Reject calendar overflow (e.g. 2024-02-30 → 2024-03-01): Date.UTC rolls
    // invalid day/month values forward, but the shared formula core treats them
    // as invalid, so round-trip the components and bail if they shifted.
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formulaDateEnd(value) {
  const text = formulaToText(value ?? "");
  const end = text.split("/")[1]?.trim();
  return formulaDate(end || text);
}

function formulaDateKeyFromDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function formulaDateTimeKeyFromDate(date) {
  const dateKey = formulaDateKeyFromDate(date);
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${dateKey}T${hour}:${minute}:${second}Z`;
}

function formulaDateRange(startValue, endValue) {
  const start = formulaDate(startValue);
  const end = formulaDate(endValue);
  if (!start || !end) return "";
  return `${formulaDateTimeKeyFromDate(start)}/${formulaDateTimeKeyFromDate(end)}`;
}

function formulaIsoWeek(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function formulaDateUnit(value) {
  const unit = formulaToText(value ?? "days").trim().toLowerCase();
  if (unit === "year" || unit === "years") return "years";
  if (unit === "quarter" || unit === "quarters") return "quarters";
  if (unit === "month" || unit === "months") return "months";
  if (unit === "week" || unit === "weeks") return "weeks";
  if (unit === "hour" || unit === "hours") return "hours";
  if (unit === "minute" || unit === "minutes") return "minutes";
  return "days";
}

function addMonthsUtc(date, months) {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

function formulaDateAdd(value, amountValue, unitValue) {
  const date = formulaDate(value);
  if (!date) return "";
  const amount = Math.trunc(formulaToNumber(amountValue ?? 0));
  const unit = formulaDateUnit(unitValue);
  let out = new Date(date.getTime());
  if (unit === "years") out = addMonthsUtc(out, amount * 12);
  else if (unit === "quarters") out = addMonthsUtc(out, amount * 3);
  else if (unit === "months") out = addMonthsUtc(out, amount);
  else if (unit === "weeks") out.setUTCDate(out.getUTCDate() + amount * 7);
  else if (unit === "hours") out.setUTCHours(out.getUTCHours() + amount);
  else if (unit === "minutes") out.setUTCMinutes(out.getUTCMinutes() + amount);
  else out.setUTCDate(out.getUTCDate() + amount);
  return formulaDateKeyFromDate(out);
}

function formulaDateBetween(endValue, startValue, unitValue) {
  const end = formulaDate(endValue);
  const start = formulaDate(startValue);
  if (!end || !start) return 0;
  const unit = formulaDateUnit(unitValue);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
  if (unit === "minutes") return Math.floor((end.getTime() - start.getTime()) / 60_000);
  if (unit === "hours") return Math.floor((end.getTime() - start.getTime()) / 3_600_000);
  if (unit === "weeks") return Math.floor(days / 7);
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) -
    (end.getUTCDate() < start.getUTCDate() ? 1 : 0);
  if (unit === "years") return Math.floor(months / 12);
  if (unit === "quarters") return Math.floor(months / 3);
  if (unit === "months") return months;
  return days;
}

function formulaDatePart(value, part) {
  const date = formulaDate(value);
  if (!date) return 0;
  if (part === "year") return date.getUTCFullYear();
  if (part === "month") return date.getUTCMonth() + 1;
  return date.getUTCDate();
}

function formulaHour(value) {
  const date = formulaDate(value);
  return date ? date.getUTCHours() : 0;
}

function formulaMinute(value) {
  const date = formulaDate(value);
  return date ? date.getUTCMinutes() : 0;
}

function formulaTimestamp(value) {
  const date = formulaDate(value);
  return date ? date.getTime() : 0;
}

function formulaFromTimestamp(value) {
  const date = new Date(formulaToNumber(value ?? null));
  return Number.isNaN(date.getTime()) ? "" : formulaDateTimeKeyFromDate(date);
}

function formulaDateRangeEndpoint(value, endpoint) {
  const date = endpoint === "end" ? formulaDateEnd(value) : formulaDate(value);
  return date ? formulaDateKeyFromDate(date) : "";
}

function formulaFormatDate(value, formatValue) {
  const date = formulaDate(value);
  if (!date) return "";
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const tokens = {
    YYYY: String(date.getUTCFullYear()),
    Y: String(date.getUTCFullYear()),
    MMM: monthNames[date.getUTCMonth()],
    MM: String(date.getUTCMonth() + 1).padStart(2, "0"),
    M: String(date.getUTCMonth() + 1),
    DD: String(date.getUTCDate()).padStart(2, "0"),
    D: String(date.getUTCDate()),
    h: String(date.getUTCHours()),
    HH: String(date.getUTCHours()).padStart(2, "0"),
    mm: String(date.getUTCMinutes()).padStart(2, "0"),
  };
  const format = formulaToText(formatValue ?? "YYYY-MM-DD") || "YYYY-MM-DD";
  return format.replace(/YYYY|MMM|HH|MM|DD|mm|Y|M|D|h/g, (token) => tokens[token] ?? token);
}

function formatFormulaValue(value) {
  if (value == null || value === "") return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return compactNumber(value);
  return String(value);
}

class FormulaParser {
  constructor(tokens, resolveProp, variables = new Map()) {
    this.tokens = tokens;
    this.resolveProp = resolveProp;
    this.variables = variables;
    this.index = 0;
  }

  peek() {
    return this.tokens[this.index];
  }

  match(type, value) {
    const token = this.peek();
    if (!token || token.type !== type || (value !== undefined && token.value !== value)) return null;
    this.index += 1;
    return token;
  }

  parse() {
    return this.equality();
  }

  equality() {
    let left = this.comparison();
    while (true) {
      if (this.match("operator", "==")) left = formulaToText(left) === formulaToText(this.comparison());
      else if (this.match("operator", "!=")) left = formulaToText(left) !== formulaToText(this.comparison());
      else return left;
    }
  }

  comparison() {
    let left = this.term();
    while (true) {
      if (this.match("operator", ">")) left = formulaToNumber(left) > formulaToNumber(this.term());
      else if (this.match("operator", ">=")) left = formulaToNumber(left) >= formulaToNumber(this.term());
      else if (this.match("operator", "<")) left = formulaToNumber(left) < formulaToNumber(this.term());
      else if (this.match("operator", "<=")) left = formulaToNumber(left) <= formulaToNumber(this.term());
      else return left;
    }
  }

  term() {
    let left = this.factor();
    while (true) {
      if (this.match("operator", "+")) {
        const right = this.factor();
        left =
          typeof left === "string" || typeof right === "string"
            ? `${formulaToText(left)}${formulaToText(right)}`
            : formulaToNumber(left) + formulaToNumber(right);
      } else if (this.match("operator", "-")) {
        left = formulaToNumber(left) - formulaToNumber(this.factor());
      } else return left;
    }
  }

  factor() {
    let left = this.power();
    while (true) {
      if (this.match("operator", "*")) left = formulaToNumber(left) * formulaToNumber(this.power());
      else if (this.match("operator", "/")) left = formulaToNumber(left) / formulaToNumber(this.power());
      else if (this.match("operator", "%")) left = formulaToNumber(left) % formulaToNumber(this.power());
      else return left;
    }
  }

  power() {
    const left = this.unary();
    if (this.match("operator", "^")) return Math.pow(formulaToNumber(left), formulaToNumber(this.power()));
    return left;
  }

  unary() {
    if (this.match("operator", "-")) return -formulaToNumber(this.unary());
    return this.primary();
  }

  variableName() {
    const token = this.match("identifier") ?? this.match("string");
    return token?.value ?? "";
  }

  bindVariable(name, value, bindings) {
    if (!name) return;
    bindings.push([name, this.variables.get(name), this.variables.has(name)]);
    this.variables.set(name, value);
  }

  restoreVariables(bindings) {
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const [name, value, hadValue] = bindings[index];
      if (hadValue) this.variables.set(name, value ?? null);
      else this.variables.delete(name);
    }
  }

  looksLikeVariableBinding() {
    const first = this.peek();
    const second = this.tokens[this.index + 1];
    return !!first && (first.type === "identifier" || first.type === "string") && second?.type === "comma";
  }

  letCall(multiple) {
    const bindings = [];
    try {
      if (!multiple) {
        const name = this.variableName();
        this.match("comma");
        const value = this.equality();
        this.match("comma");
        this.bindVariable(name, value, bindings);
        const result = this.equality();
        this.match("paren", ")");
        return result;
      }

      while (this.looksLikeVariableBinding()) {
        const name = this.variableName();
        this.match("comma");
        const value = this.equality();
        this.bindVariable(name, value, bindings);
        if (!this.match("comma")) {
          this.match("paren", ")");
          return "";
        }
        if (!this.looksLikeVariableBinding()) {
          const result = this.equality();
          this.match("paren", ")");
          return result;
        }
      }

      const result = this.equality();
      this.match("paren", ")");
      return result;
    } finally {
      this.restoreVariables(bindings);
    }
  }

  primary() {
    const number = this.match("number");
    if (number) return Number(number.value);
    const string = this.match("string");
    if (string) return string.value;
    const identifier = this.match("identifier");
    if (identifier) {
      const name = identifier.value;
      if (this.match("paren", "(")) {
        if (name === "let") return this.letCall(false);
        if (name === "lets") return this.letCall(true);
        const args = [];
        if (!this.match("paren", ")")) {
          do {
            args.push(this.equality());
          } while (this.match("comma"));
          this.match("paren", ")");
        }
        return this.call(name, args);
      }
      if (name === "true") return true;
      if (name === "false") return false;
      if (name === "null") return null;
      if (this.variables.has(name)) return this.variables.get(name) ?? "";
      return "";
    }
    if (this.match("paren", "(")) {
      const value = this.equality();
      this.match("paren", ")");
      return value;
    }
    return "";
  }

  call(name, args) {
    switch (name) {
      case "prop":
        return this.resolveProp(formulaToText(args[0]));
      case "if":
        return formulaToBoolean(args[0]) ? (args[1] ?? "") : (args[2] ?? "");
      case "ifs": {
        for (let index = 0; index + 1 < args.length; index += 2) {
          if (formulaToBoolean(args[index] ?? null)) return args[index + 1] ?? "";
        }
        return args.length % 2 === 1 ? (args[args.length - 1] ?? "") : "";
      }
      case "concat":
        return args.map(formulaToText).join("");
      case "repeat":
        return formulaRepeat(args[0], args[1]);
      case "format":
        return formatFormulaValue(args[0]);
      case "toNumber":
        return formulaToNumber(args[0]);
      case "add":
        return formulaNumbers(args).reduce((sum, value) => sum + value, 0);
      case "subtract":
        return formulaToNumber(args[0] ?? null) - formulaToNumber(args[1] ?? null);
      case "multiply":
        return formulaNumbers(args).reduce((product, value) => product * value, args.length ? 1 : 0);
      case "divide":
        return formulaToNumber(args[0] ?? null) / formulaToNumber(args[1] ?? null);
      case "mod":
        return formulaToNumber(args[0] ?? null) % formulaToNumber(args[1] ?? null);
      case "pow":
        return Math.pow(formulaToNumber(args[0] ?? null), formulaToNumber(args[1] ?? null));
      case "min":
        return args.length ? Math.min(...formulaNumbers(args)) : 0;
      case "max":
        return args.length ? Math.max(...formulaNumbers(args)) : 0;
      case "sum":
        return formulaNumbers(args).reduce((sum, value) => sum + value, 0);
      case "mean":
        return args.length ? formulaNumbers(args).reduce((sum, value) => sum + value, 0) / args.length : 0;
      case "median":
        return formulaMedian(args);
      case "sqrt":
        return Math.sqrt(formulaToNumber(args[0] ?? null));
      case "cbrt":
        return Math.cbrt(formulaToNumber(args[0] ?? null));
      case "exp":
        return Math.exp(formulaToNumber(args[0] ?? null));
      case "ln":
        return Math.log(formulaToNumber(args[0] ?? null));
      case "log10":
        return Math.log10(formulaToNumber(args[0] ?? null));
      case "log2":
        return Math.log2(formulaToNumber(args[0] ?? null));
      case "sign":
        return Math.sign(formulaToNumber(args[0] ?? null));
      case "pi":
        return Math.PI;
      case "e":
        return Math.E;
      case "lower":
        return formulaToText(args[0] ?? "").toLowerCase();
      case "upper":
        return formulaToText(args[0] ?? "").toUpperCase();
      case "trim":
        return formulaToText(args[0] ?? "").trim();
      case "startsWith":
        return formulaToText(args[0] ?? "").startsWith(formulaToText(args[1] ?? ""));
      case "endsWith":
        return formulaToText(args[0] ?? "").endsWith(formulaToText(args[1] ?? ""));
      case "substring":
        return formulaSubstring(args[0], args[1], args[2]);
      case "replace":
        return formulaReplace(args[0], args[1], args[2]);
      case "replaceAll":
        return formulaReplace(args[0], args[1], args[2], true);
      case "test":
        return formulaTest(args[0], args[1]);
      case "now":
        return formulaDateTimeKeyFromDate(new Date());
      case "today":
        return formulaDateKeyFromDate(new Date());
      case "dateAdd":
        return formulaDateAdd(args[0], args[1], args[2]);
      case "dateSubtract":
        return formulaDateAdd(args[0], -formulaToNumber(args[1] ?? 0), args[2]);
      case "dateBetween":
        return formulaDateBetween(args[0], args[1], args[2]);
      case "dateRange":
        return formulaDateRange(args[0], args[1]);
      case "parseDate": {
        const date = formulaDate(args[0]);
        return date ? formulaDateTimeKeyFromDate(date) : "";
      }
      case "dateStart":
        return formulaDateRangeEndpoint(args[0], "start");
      case "dateEnd":
        return formulaDateRangeEndpoint(args[0], "end");
      case "timestamp":
        return formulaTimestamp(args[0]);
      case "fromTimestamp":
        return formulaFromTimestamp(args[0]);
      case "formatDate":
        return formulaFormatDate(args[0], args[1]);
      case "year":
        return formulaDatePart(args[0], "year");
      case "month":
        return formulaDatePart(args[0], "month");
      case "day":
        return formulaDatePart(args[0], "day");
      case "date":
        return formulaDatePart(args[0], "day");
      case "week": {
        const date = formulaDate(args[0]);
        return date ? formulaIsoWeek(date) : 0;
      }
      case "hour":
        return formulaHour(args[0]);
      case "minute":
        return formulaMinute(args[0]);
      case "round":
        return formulaRound(args[0], args[1]);
      case "floor":
        return Math.floor(formulaToNumber(args[0]));
      case "ceil":
        return Math.ceil(formulaToNumber(args[0]));
      case "abs":
        return Math.abs(formulaToNumber(args[0]));
      case "empty":
        return args[0] == null || args[0] === "" || args[0] === 0;
      case "contains":
        return formulaToText(args[0]).toLowerCase().includes(formulaToText(args[1]).toLowerCase());
      case "length":
        return formulaToText(args[0]).length;
      case "not":
        return !formulaToBoolean(args[0]);
      case "and":
        return args.every(formulaToBoolean);
      case "or":
        return args.some(formulaToBoolean);
      default:
        return "";
    }
  }
}

function propValue(row, prop) {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  if (prop.type === "created_by") return row.createdBy;
  if (prop.type === "last_edited_by") return row.lastEditedBy;
  return row.properties?.[prop.id];
}

function relationTargetProps(relationProp, propsByDb = {}) {
  const dbId = relationProp.config?.relationDatabaseId ?? relationProp.databaseId;
  return propsByDb[dbId] ?? [];
}

function followRelation(page, relationProp, pagesById = {}) {
  return ids(propValue(page, relationProp))
    .map((id) => pagesById[id])
    .filter((related) => related && !related.inTrash);
}

function resolveRollupHops(startPages, targetProp, prop, propsByDb = {}, pagesById = {}) {
  let pages = startPages;
  let current = targetProp;
  const seenDbs = new Set();

  for (let hop = 0; hop < 3; hop += 1) {
    if (!current) break;
    if (current.type !== "relation" && current.type !== "rollup") break;

    const ownerProps = propsByDb[current.databaseId] ?? [];
    let hopRelation;
    if (current.type === "relation") {
      hopRelation = current;
    } else {
      const viaId = hop === 0 ? prop.config?.rollupVia : undefined;
      hopRelation =
        (viaId ? ownerProps.find((item) => item.id === viaId) : undefined) ??
        ownerProps.find((item) => item.id === current?.config?.rollupRelationPropertyId);
    }
    if (!hopRelation || hopRelation.type !== "relation") break;

    const hopDbId = hopRelation.config?.relationDatabaseId ?? hopRelation.databaseId;
    if (seenDbs.has(hopDbId)) break;
    seenDbs.add(hopDbId);

    pages = pages.flatMap((page) => followRelation(page, hopRelation, pagesById));
    const hopProps = relationTargetProps(hopRelation, propsByDb);
    current =
      current.type === "rollup"
        ? hopProps.find((item) => item.id === current?.config?.rollupTargetPropertyId)
        : undefined;
  }

  return { pages, targetProp: current };
}

export function evaluateRollupValue(row, prop, pagesById = {}, props = [], propsByDb = {}) {
  const sourceProps = propsByDb[prop.databaseId] ?? props;
  const relationProp = sourceProps.find((item) => item.id === prop.config?.rollupRelationPropertyId);
  if (!relationProp) return "";

  const relatedPages = followRelation(row, relationProp, pagesById);
  const fn = prop.config?.rollupFunction ?? "show_original";
  if (fn === "count_all") return relatedPages.length;

  const targetProps = relationTargetProps(relationProp, propsByDb);
  const firstHopTarget = targetProps.find((item) => item.id === prop.config?.rollupTargetPropertyId);
  const { pages: leafPages, targetProp } =
    firstHopTarget && (firstHopTarget.type === "relation" || firstHopTarget.type === "rollup")
      ? resolveRollupHops(relatedPages, firstHopTarget, prop, propsByDb, pagesById)
      : { pages: relatedPages, targetProp: firstHopTarget };

  const values = targetProp
    ? leafPages.map((page) => propValue(page, targetProp))
    : leafPages.map((page) => page.title);
  const presentValues = values.filter(valueIsPresent);

  if (fn === "count_values") return presentValues.length;
  if (fn === "count_unique") return new Set(values.flatMap(rollupValuePieces)).size;
  if (fn === "count_empty") return values.length - presentValues.length;
  if (fn === "percent_empty") return rollupPercent(values.length - presentValues.length, values.length);
  if (fn === "percent_not_empty") return rollupPercent(presentValues.length, values.length);

  const checkedCount = values.filter(rollupCheckedValue).length;
  if (fn === "checked") return String(checkedCount);
  if (fn === "unchecked") return String(values.length - checkedCount);
  if (fn === "percent_checked") return rollupPercent(checkedCount, values.length);
  if (fn === "percent_unchecked") return rollupPercent(values.length - checkedCount, values.length);

  const numbers = presentValues.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (fn === "sum") return numbers.length ? compactNumber(numbers.reduce((sum, value) => sum + value, 0)) : "";
  if (fn === "average") {
    return numbers.length ? compactNumber(numbers.reduce((sum, value) => sum + value, 0) / numbers.length) : "";
  }
  if (fn === "median") {
    if (!numbers.length) return "";
    const sorted = numbers.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return compactNumber(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
  }
  if (fn === "min") return numbers.length ? compactNumber(Math.min(...numbers)) : "";
  if (fn === "max") return numbers.length ? compactNumber(Math.max(...numbers)) : "";
  if (fn === "range") return numbers.length ? compactNumber(Math.max(...numbers) - Math.min(...numbers)) : "";

  const dates = values.flatMap(rollupDateValues).sort((a, b) => a.getTime() - b.getTime());
  if (fn === "earliest_date") return dates.length ? formulaDateKeyFromDate(dates[0]) : "";
  if (fn === "latest_date") return dates.length ? formulaDateKeyFromDate(dates[dates.length - 1]) : "";
  if (fn === "date_range") {
    if (!dates.length) return "";
    const start = formulaDateKeyFromDate(dates[0]);
    const end = formulaDateKeyFromDate(dates[dates.length - 1]);
    return start === end ? start : `${start} → ${end}`;
  }

  if (!targetProp) return leafPages.map((page) => titleOf(page)).join(", ");
  return leafPages
    .map((page) =>
      targetProp.type === "rollup"
        ? ""
        : formatDbValue(page, targetProp, pagesById, propsByDb[targetProp.databaseId] ?? [], propsByDb)
    )
    .filter(Boolean)
    .join(", ");
}

function databasePropsContext(pages, databaseId, props) {
  const out = { [databaseId]: props };
  const databaseIds = pages
    .filter((page) => page.kind === "database" && page.id !== databaseId)
    .map((page) => page.id);
  return Promise.all(databaseIds.map((id) => eb.dbProperties(id))).then((propsByIndex) => {
    databaseIds.forEach((id, index) => {
      out[id] = propsByIndex[index];
    });
    return out;
  });
}

function evaluateFormulaValue(row, prop, props = [], pagesById = {}, propsByDb = {}) {
  const expression = prop.config?.formula?.trim();
  if (!expression) return "";
  try {
    const parser = new FormulaParser(tokenizeFormula(expression), (name) => {
      const target = props.find((item) => item.name === name || item.id === name);
      if (!target || target.id === prop.id) return "";
      const value = propValue(row, target);
      if (typeof value === "number" || typeof value === "boolean") return value;
      if (value == null) return "";
      if (target.type === "number" || target.type === "checkbox") return value;
      if (target.type === "date") {
        if (typeof value === "string") return value;
        if (value && typeof value === "object") {
          const start = value.start;
          const end = value.end;
          if (typeof start === "string" && typeof end === "string" && end) return `${start}/${end}`;
          return typeof start === "string" ? start : "";
        }
      }
      if (target.type === "formula" || target.type === "rollup") return "";
      return formatDbValue(row, target, pagesById, props, propsByDb);
    });
    return parser.parse();
  } catch {
    return "";
  }
}

function formatDbValue(row, prop, pagesById = {}, props = [], propsByDb = {}) {
  const value = propValue(row, prop);
  if ((prop.type === "formula" || prop.type === "rollup") && row.__computed?.[prop.id]?.formatted !== undefined) {
    return String(row.__computed[prop.id].formatted ?? "");
  }
  if (prop.type === "formula") return formatFormulaValue(evaluateFormulaValue(row, prop, props, pagesById, propsByDb));
  if (prop.type === "rollup") {
    // evaluateRollupValue returns typed values (numbers for count_* to match
    // the shared rollup core); formatDbValue is the display/text contract, so
    // coerce back to a string here for downstream text consumers.
    const rollup = evaluateRollupValue(row, prop, pagesById, props, propsByDb);
    return typeof rollup === "number" ? String(rollup) : rollup;
  }
  if (value == null || value === "") return "";
  if (prop.type === "select" || prop.type === "status") return optionName(prop, value);
  if (prop.type === "multi_select") return ids(value).map((id) => optionName(prop, id)).join(", ");
  if (prop.type === "checkbox") return value ? "Checked" : "Unchecked";
  if (prop.type === "number") return formatNumberValue(value, prop.config?.numberFormat ?? "number");
  if (prop.type === "unique_id") {
    const prefix = prop.config?.idPrefix?.trim();
    return prefix ? `${prefix}-${value}` : String(value);
  }
  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
    return String(value).slice(0, 10);
  }
  if (prop.type === "relation") {
    return ids(value).map((id) => pagesById[id] ? titleOf(pagesById[id]) : id).join(", ");
  }
  if (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") {
    return personIds(value).map((id) => personLabel(id)).join(", ");
  }
  if (prop.type === "files") {
    const files = Array.isArray(value) ? value : [value];
    return files
      .map((file) => {
        if (typeof file === "string") return file;
        return file?.name || file?.fileName || file?.url || "";
      })
      .filter(Boolean)
      .join(", ");
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function dateKey(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function viewOptionIds(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === "") return [];
  return [String(value)];
}

function viewOptionTargets(prop, value) {
  const raw = viewOptionIds(value);
  const options = prop.config?.options ?? [];
  return new Set(
    raw.map((item) => {
      const found = options.find(
        (option) => option.id === item || option.name.toLowerCase() === item.toLowerCase()
      );
      return found?.id ?? item;
    })
  );
}

function matchesViewFilter(row, prop, filter, pagesById, props = [], propsByDb = {}) {
  const value = propValue(row, prop);
  const text = formatDbValue(row, prop, pagesById, props, propsByDb).toLowerCase();
  const query = String(filter.value ?? "").toLowerCase().trim();

  if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status") {
    const ids = viewOptionIds(value);
    const targets = viewOptionTargets(prop, filter.value);
    const hasTarget = ids.some((id) => targets.has(id));
    if (filter.operator === "equals") return hasTarget;
    if (filter.operator === "does_not_equal") return !hasTarget;
    if (filter.operator === "is_empty") return ids.length === 0;
    if (filter.operator === "is_not_empty") return ids.length > 0;
    return true;
  }

  if (prop.type === "checkbox") {
    const checked = value === true || value === "true";
    const want = filter.value === true || filter.value === "true";
    if (filter.operator === "equals") return checked === want;
    if (filter.operator === "does_not_equal") return checked !== want;
    return true;
  }

  if (prop.type === "number") {
    const n = Number(value);
    const q = Number(filter.value);
    if (filter.operator === "equals") return n === q;
    if (filter.operator === "does_not_equal") return n !== q;
    if (filter.operator === "greater_than") return n > q;
    if (filter.operator === "less_than") return n < q;
    if (filter.operator === "is_empty") return value == null || value === "";
    if (filter.operator === "is_not_empty") return value != null && value !== "";
    return true;
  }

  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
    const rowDate = dateKey(value);
    const filterDate = dateKey(filter.value);
    if (filter.operator === "is_empty") return rowDate === "";
    if (filter.operator === "is_not_empty") return rowDate !== "";
    if (filter.operator === "equals") return rowDate !== "" && rowDate === filterDate;
    if (filter.operator === "on_or_after") return rowDate !== "" && rowDate >= filterDate;
    if (filter.operator === "on_or_before") return rowDate !== "" && rowDate <= filterDate;
    return true;
  }

  if (filter.operator === "equals") return text === query;
  if (filter.operator === "does_not_equal") return text !== query;
  if (filter.operator === "contains") return query === "" || text.includes(query);
  if (filter.operator === "does_not_contain") return !text.includes(query);
  if (filter.operator === "is_empty") return text === "";
  if (filter.operator === "is_not_empty") return text !== "";
  if (filter.operator === "greater_than") return Number(value) > Number(filter.value);
  if (filter.operator === "less_than") return Number(value) < Number(filter.value);
  if (filter.operator === "on_or_after") return String(value ?? "") >= String(filter.value ?? "");
  if (filter.operator === "on_or_before") return String(value ?? "") <= String(filter.value ?? "");
  return true;
}

function matchesViewFilterGroup(row, group, propsById, pagesById, props = [], propsByDb = {}) {
  const terms = [];
  for (const filter of group?.filters ?? []) {
    const prop = propsById.get(filter.propertyId);
    if (prop) terms.push(matchesViewFilter(row, prop, filter, pagesById, props, propsByDb));
  }
  for (const subgroup of group?.groups ?? []) {
    terms.push(matchesViewFilterGroup(row, subgroup, propsById, pagesById, props, propsByDb));
  }
  if (terms.length === 0) return true;
  return group.conjunction === "or" ? terms.some(Boolean) : terms.every(Boolean);
}

function viewSortKey(row, prop, pagesById, props = [], propsByDb = {}) {
  const value = propValue(row, prop);
  if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
    const first = viewOptionIds(value)[0];
    const index = (prop.config?.options ?? []).findIndex((option) => option.id === first);
    return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
  }
  if (prop.type === "number" || prop.type === "unique_id") {
    const n = Number(value);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  }
  if (prop.type === "checkbox") return value ? 1 : 0;
  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
    return dateKey(value) || "￿";
  }
  return formatDbValue(row, prop, pagesById, props, propsByDb).toLowerCase();
}

function compareViewSortKeys(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function viewDisplayProperties(props, view) {
  if (!view) return props;
  const order = view.config?.propertyOrder ?? props.map((prop) => prop.id);
  const visible = new Set(view.config?.visibleProperties ?? props.map((prop) => prop.id));
  const byId = new Map(props.map((prop) => [prop.id, prop]));
  const out = [];
  for (const id of order) {
    const prop = byId.get(id);
    if (prop && visible.has(prop.id)) {
      out.push(prop);
      byId.delete(id);
    }
  }
  for (const prop of props) {
    if (byId.has(prop.id) && visible.has(prop.id)) out.push(prop);
  }
  return out.length ? out : props;
}

function applyDatabaseView(rows, props, pagesById, view, search, propsByDb = {}) {
  const propsById = new Map(props.map((prop) => [prop.id, prop]));
  let out = rows.slice();
  const query = String(search ?? view?.config?.search ?? "").trim().toLowerCase();
  if (query) {
    out = out.filter((row) =>
      props.some((prop) => formatDbValue(row, prop, pagesById, props, propsByDb).toLowerCase().includes(query))
    );
  }
  if (view?.config?.filterGroup) {
    out = out.filter((row) => matchesViewFilterGroup(row, view.config.filterGroup, propsById, pagesById, props, propsByDb));
  } else {
    const filters = (view?.config?.filters ?? []).filter((filter) => propsById.has(filter.propertyId));
    if (filters.length) {
      const conjunction = view.config?.filterConjunction === "or" ? "or" : "and";
      out = out.filter((row) => {
        const results = filters.map((filter) =>
          matchesViewFilter(row, propsById.get(filter.propertyId), filter, pagesById, props, propsByDb)
        );
        return conjunction === "or" ? results.some(Boolean) : results.every(Boolean);
      });
    }
  }
  for (const sort of [...(view?.config?.sorts ?? [])].reverse()) {
    const prop = propsById.get(sort.propertyId);
    if (!prop) continue;
    out.sort((a, b) => {
      const result = compareViewSortKeys(
        viewSortKey(a, prop, pagesById, props, propsByDb),
        viewSortKey(b, prop, pagesById, props, propsByDb)
      );
      return sort.direction === "desc" ? -result : result;
    });
  }
  return out;
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
const DATABASE_VIEW_TYPES = ["table", "board", "list", "gallery", "calendar", "timeline"];
/** @type {[string, ...string[]]} */
const NOTION_VIEW_TYPES = [...DATABASE_VIEW_TYPES, "form", "chart", "map", "dashboard"];
const UNSUPPORTED_NOTION_VIEW_TYPES = NOTION_VIEW_TYPES.filter((type) => !DATABASE_VIEW_TYPES.includes(type));
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

function persistableDatabaseRowProperties(properties = {}) {
  return Object.fromEntries(
    Object.entries(properties ?? {}).filter(([key]) => !String(key).startsWith("__"))
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
    scopeModel: "hanji_account_workspace",
  });
  return {
    scopeModel: "hanji_account_accessible_workspaces",
    notionCompatibilityNote:
      "Hanji MCP authenticates as an account. Choose one listed workspace id and pass it as workspace_id to workspace-bound tools. Notion-compatible teamspace_id is accepted as an alias.",
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
  /<(?=\/?(?:content|page|properties|ancestor-path|discussions?|comment|quote|anchor|data-source|data-source-state|sqlite-table|columns?|empty-block|database)\b)/gi;

export function escapeFramingBreakouts(value) {
  return String(value ?? "").replace(FRAMING_TAG_PATTERN, "&lt;");
}

function jsonText(value) {
  return JSON.stringify(value ?? {});
}

function stripHanjiId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const collection = raw.match(/^collection:\/\/([0-9a-f-]{32,36})$/i);
  if (collection?.[1]) return collection[1];
  const viewUri = raw.match(/^view:\/\/([0-9a-f-]{32,36})$/i);
  if (viewUri?.[1]) return viewUri[1];
  const viewParam = raw.match(/[?&]v=([0-9a-f-]{32,36})/i);
  if (viewParam?.[1]) return viewParam[1];
  const urlPage = raw.match(/\/(?:p|page|database)\/([0-9a-f-]{32,36})/i);
  if (urlPage?.[1]) return urlPage[1];
  const uuid = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid?.[0]) return uuid[0];
  const compact = raw.match(/[0-9a-f]{32}/i);
  if (compact?.[0]) {
    const id = compact[0];
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  }
  return raw;
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

function accountWorkspaceSelectionPayload(workspaces, toolName) {
  return {
    error: "workspace_id_required",
    tool: toolName,
    message:
      "Hanji MCP is account-scoped. Choose one workspace from this list and pass its id as workspace_id. Notion-compatible teamspace_id is accepted as an alias.",
    required_argument: "workspace_id",
    accepted_aliases: ["teamspace_id", "workspaceId"],
    workspaces: workspaceStructuredContent({ workspaces }).workspaces,
  };
}

async function requireWorkspaceSelection(input, toolName) {
  const workspaceId = selectedWorkspaceId(input);
  if (workspaceId) return { workspaceId };
  const workspaces = await accountAccessibleWorkspaces();
  return {
    errorResult: {
      content: [
        {
          type: /** @type {"text"} */ ("text"),
          text: JSON.stringify(accountWorkspaceSelectionPayload(workspaces, toolName)),
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
  source = "account",
  pageScopeWorkspaceId = null,
  conflict = null,
} = {}) {
  const effectiveWorkspaceIds = uniqueStrings(workspaceIds);
  return {
    scope: {
      provider: "hanji",
      access_model: "account_accessible_workspaces",
      notion_reference_model: "workspace_scoped_connection",
      target,
      source,
      teamspace_id_alias: "Hanji workspace_id",
      requested_teamspace_id: requestedTeamspaceId || null,
      effective_workspace_ids: effectiveWorkspaceIds,
      page_scope_workspace_id: pageScopeWorkspaceId || null,
      conflict,
      note:
        "Notion MCP is typically bound to one connected workspace. Hanji MCP is account-scoped, so workspace_id is required for workspace-bound tools. Notion-compatible teamspace_id is accepted as a Hanji workspace_id alias.",
    },
  };
}

async function accountAccessibleWorkspaces() {
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

async function notionPageFetchPayload(page, includeDiscussions = false) {
  const [blocks, pages] = await Promise.all([eb.blocks(page.id), eb.pageProjection({ workspaceId: page.workspaceId })]);
  const pagesById = Object.fromEntries(pages.map((item) => [item.id, item]));
  const props = page.parentType === "database" && page.parentId ? await eb.dbProperties(page.parentId) : [];
  const propsByDb = props.length ? await databasePropsContext(pages, page.parentId, props) : {};
  const properties = pagePropertiesForNotion(page, pagesById, props, propsByDb);
  const content = enhancedBlocksToMarkdown(blocks, pagesById) || "<empty-block/>";
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
  };
}

async function databaseRowsForNotionSearch(databaseId, query, limit, filters = {}) {
  const safeLimit = clamp(limit, 1, 25);
  const db = await eb.getOne("pages", databaseId);
  if (!db || db.kind !== "database") return [];
  const [props, rows, pages] = await Promise.all([
    eb.dbProperties(databaseId),
    eb.dbRows(databaseId, { includeComputed: true }),
    eb.pages(),
  ]);
  const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const needle = String(query ?? "").trim().toLowerCase();
  const matches = [];
  for (const row of rows) {
    if (!matchesNotionSearchFilters(row, filters)) continue;
    const haystack = [
      row.title,
      ...props.map((prop) => formatDbValue(row, prop, pagesById, props)),
    ].join("\n");
    if (needle && !haystack.toLowerCase().includes(needle)) continue;
    const highlight = props
      .map((prop) => formatDbValue(row, prop, pagesById, props))
      .find((value) => needle && value.toLowerCase().includes(needle));
    matches.push(notionSearchResult(row, highlight || row.title));
    if (matches.length >= safeLimit) break;
  }
  return matches;
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

  const updated = await eb.update("pages", pageId, { parentId, parentType, position, ...pageEditAudit() });
  return { page: updated, parentId, parentType, position };
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
      options: names.map((name, index) => ({
        id: eb.newId(),
        name: String(name),
        color: OPTION_COLORS[index % OPTION_COLORS.length],
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
    if (input.twoWay === true) config.relatedPropertyId = eb.newId();
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
    throw new Error(`${label} must use ${allowedTypes.join(" or ")} properties.`);
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

function defaultViewConfigForType(type, props, base = {}) {
  const config = /** @type {Record<string, any>} */ ({ ...(base ?? {}) });
  const propIds = props.map((prop) => prop.id);
  if (!Array.isArray(config.propertyOrder)) config.propertyOrder = propIds;
  if (!Array.isArray(config.visibleProperties)) config.visibleProperties = propIds;
  if (type === "board" && !config.groupBy) {
    const groupProp = props.find((prop) => prop.type === "select" || prop.type === "status");
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

function viewConfigPatchForInput(props, type, input = {}, base = {}) {
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
  setProperty("groupBy", input.groupBy, "groupBy", ["select", "status"]);
  if (input.subGroupBy !== undefined) {
    if (type !== "board") throw new Error("subGroupBy can only be set on board views.");
    const subGroupBy = propertyIdForViewInput(props, input.subGroupBy, "subGroupBy", ["select", "status"]);
    if (subGroupBy && subGroupBy === config.groupBy) {
      throw new Error("subGroupBy must be different from groupBy.");
    }
    if (subGroupBy) config.subGroupBy = subGroupBy;
    else delete config.subGroupBy;
    changed.push("subGroupBy");
  }
  setProperty("calendarBy", input.calendarBy, "calendarBy", ["date"]);
  setProperty("timelineBy", input.timelineBy, "timelineBy", ["date"]);
  setProperty("timelineEndBy", input.timelineEndBy, "timelineEndBy", ["date"]);
  setProperty("dependencyProperty", input.dependencyProperty, "dependencyProperty", ["relation"]);

  if (input.coverProperty !== undefined) {
    const raw = String(input.coverProperty).trim();
    if (!raw || raw === "__page_cover" || raw.toLowerCase() === "page") config.coverProperty = undefined;
    else if (raw === "__none" || raw.toLowerCase() === "none") config.coverProperty = "__none";
    else config.coverProperty = propertyIdForViewInput(props, raw, "coverProperty", ["files", "url"]);
    changed.push("coverProperty");
  }
  if (input.wrap !== undefined) {
    config.wrap = input.wrap;
    changed.push("wrap");
  }
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

server.registerTool(
  "get_workspace",
  {
    title: "Get workspace",
    description:
      "Get the account workspace selection context. Hanji MCP is account-scoped, so call this first and pass one returned workspace id as workspace_id to workspace-bound tools.",
    inputSchema: {},
  },
  async () => {
    try {
      const ws = await eb.workspace();
      const pages = await eb.pages();
      const workspaces = await accountAccessibleWorkspaces();
      const icon = String(ws.icon ?? "").trim();
      const iconPrefix = icon && !looksLikeImageIcon(icon) ? `${icon} ` : "";
      const iconLine = icon
        ? `\nicon: ${looksLikeImageIcon(icon) ? `image ${icon}` : icon}`
        : "\nicon: none";
      const selectionLines = workspaceLines({ workspaces });
      return ok(
        [
          "Hanji MCP is account-scoped. Choose one workspace below and pass its id as workspace_id.",
          "",
          `Current fallback workspace: ${iconPrefix}${ws.name}`,
          `current fallback id: ${ws.id}${iconLine}`,
          `current fallback pages: ${pages.length}`,
          "",
          ...selectionLines,
        ].join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "get_mcp_access_policy",
  {
    title: "Get MCP access policy",
    description:
      "Show the local MCP client narrowing policy. Hanji MCP authenticates at account scope; product permissions still come from the authenticated EdgeBase user or service principal, and this policy can narrow that access.",
    inputSchema: {},
    outputSchema: MCP_ACCESS_POLICY_OUTPUT_SCHEMA,
  },
  async () => {
    try {
      const policy = eb.mcpAccessPolicy();
      const list = (items) => (items.length ? items.join(", ") : "(none)");
      return okStructured(
        [
          `readOnly: ${policy.readOnly ? "true" : "false"}`,
          `policyFile: ${policy.policyFile || "(none)"}`,
          `clientId: ${policy.clientId || "(default)"}`,
          `clientName: ${policy.clientName || "(default)"}`,
          `subjectType: ${policy.subjectType || "(none)"}`,
          `subjectId: ${policy.subjectId || "(none)"}`,
          `issuer: ${policy.issuer || "(none)"}`,
          `audience: ${policy.audience || "(none)"}`,
          `transport: ${policy.transport || "(none)"}`,
          `provisioningId: ${policy.provisioningId || "(none)"}`,
          `notBefore: ${policy.notBefore || "(none)"}`,
          `expiresAt: ${policy.expiresAt || "(none)"}`,
          `allowedWorkspaceIds: ${list(policy.allowedWorkspaceIds)}`,
          `allowedPageIds: ${list(policy.allowedPageIds)}`,
          `allowedDatabaseIds: ${list(policy.allowedDatabaseIds)}`,
          `scopes: ${list(policy.scopes)}`,
        ].join("\n"),
        {
          ...policy,
          scopeModel: "hanji_account_accessible_workspaces",
          notionCompatibilityNote:
            "Unlike a Notion MCP connection scoped to one workspace, Hanji authenticates at account scope. Workspace-bound tools require workspace_id, with Notion-compatible teamspace_id accepted as an alias.",
        }
      );
    } catch (e) {
      return fail(e);
    }
  }
);

const NOTION_SEARCH_INPUT_SCHEMA = {
  query: z.string().describe("Search query"),
  query_type: z.enum(["internal", "user"]).optional().describe("Use user to search workspace members; internal searches pages/databases/rows."),
  content_search_mode: z.enum(["workspace_search", "ai_search"]).optional(),
  data_source_url: z.string().optional().describe("collection://<database-id> to search rows in a database/data source"),
  page_url: z.string().optional().describe("Page URL or id to restrict search to a page subtree"),
  workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
  teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
  page_size: z.number().int().min(1).max(25).optional(),
  max_highlight_length: z.number().int().min(0).max(1000).optional(),
  filters: JsonValueSchema.optional().describe("Accepted for Notion MCP compatibility; unsupported filter keys are ignored."),
};

async function handleNotionSearch({
  query,
  query_type = "internal",
  content_search_mode = "workspace_search",
  data_source_url,
  page_url,
  workspace_id,
  teamspace_id,
  page_size = 10,
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

    if (query_type === "user") {
      const people = [];
      for (const workspace of scope.workspaces) {
        const members = await eb.workspaceMembers(workspace.id);
        for (const member of members.members ?? []) {
          const label = workspaceMemberLabel(member);
          const email = member.email ?? "";
          const haystack = `${label}\n${email}\n${member.userId ?? ""}`.toLowerCase();
          if (!haystack.includes(query.toLowerCase())) continue;
          people.push({
            id: member.userId || member.id,
            title: label,
            type: "user",
            email: email || undefined,
            workspace_id: workspace.id,
            workspace: workspace.name,
          });
          if (people.length >= limit) break;
        }
        if (people.length >= limit) break;
      }
      return okJson(notionSearchResponse(
        people,
        "user",
        hanjiScopeMetadata({
          workspaceIds: scope.workspaceIds,
          requestedTeamspaceId: scope.requestedTeamspaceId,
          target: "user_search",
          source: scope.source,
        })
      ));
    }

    if (data_source_url) {
      const databaseId = stripHanjiId(data_source_url);
      const db = await eb.getOne("pages", databaseId);
      const databaseWorkspaceId = db?.workspaceId ?? null;
      if (scope.requestedTeamspaceId && databaseWorkspaceId && scope.requestedTeamspaceId !== databaseWorkspaceId) {
        return okJson(notionSearchResponse(
          [],
          "workspace_search",
          hanjiScopeMetadata({
            workspaceIds: [scope.requestedTeamspaceId],
            requestedTeamspaceId: scope.requestedTeamspaceId,
            target: "data_source_search",
            source: scope.source,
            conflict: "data_source_workspace_does_not_match_teamspace_id",
          })
        ));
      }
      const results = (await databaseRowsForNotionSearch(databaseId, query, limit, filters)).map(trimHighlight);
      return okJson(notionSearchResponse(
        results,
        "workspace_search",
        hanjiScopeMetadata({
          workspaceIds: databaseWorkspaceId ? [databaseWorkspaceId] : scope.workspaceIds,
          requestedTeamspaceId: scope.requestedTeamspaceId,
          target: "data_source_search",
          source: databaseWorkspaceId ? "data_source_url" : scope.source,
        })
      ));
    }

    let pageScopeIds = null;
    let pageScopeWorkspaceId = null;
    if (page_url) {
      const rootId = stripHanjiId(page_url);
      const root = await eb.getOne("pages", rootId);
      if (root?.workspaceId) {
        pageScopeWorkspaceId = root.workspaceId;
        if (scope.requestedTeamspaceId && scope.requestedTeamspaceId !== root.workspaceId) {
          return okJson(notionSearchResponse(
            [],
            "workspace_search",
            hanjiScopeMetadata({
              workspaceIds: [scope.requestedTeamspaceId],
              requestedTeamspaceId: scope.requestedTeamspaceId,
              target: "page_subtree_search",
              source: scope.source,
              pageScopeWorkspaceId,
              conflict: "page_workspace_does_not_match_teamspace_id",
            })
          ));
        }
        const pages = await eb.pageProjection({ workspaceId: root.workspaceId });
        pageScopeIds = collectPageSubtree(pages, rootId);
      } else {
        pageScopeIds = new Set([rootId]);
      }
    }

    const workspaceIds = pageScopeWorkspaceId ? [pageScopeWorkspaceId] : scope.workspaceIds;
    const scanLimit = Math.max(limit * 3, limit);
    const results = [];
    const seen = new Set();
    for (const workspaceId of workspaceIds) {
      const hits = await eb.searchPages(query, { workspaceId, limit: scanLimit });
      for (const page of hits) {
        if (pageScopeIds && !pageScopeIds.has(page.id)) continue;
        if (!matchesNotionSearchFilters(page, filters)) continue;
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        results.push(trimHighlight(notionSearchResult(page)));
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }

    if (results.length < limit) {
      for (const workspaceId of workspaceIds) {
        const blocks = await eb.searchBlocks(query, { workspaceId, limit: scanLimit });
        const pagesById = Object.fromEntries((await eb.pageProjection({ workspaceId })).map((page) => [page.id, page]));
        for (const block of blocks) {
          if (pageScopeIds && !pageScopeIds.has(block.pageId)) continue;
          const page = pagesById[block.pageId];
          if (page && !matchesNotionSearchFilters(page, filters)) continue;
          if (!page || seen.has(page.id)) continue;
          seen.add(page.id);
          results.push(trimHighlight(notionSearchResult(page, blockPreview(block))));
          if (results.length >= limit) break;
        }
        if (results.length >= limit) break;
      }
    }

    const scopeExtra = hanjiScopeMetadata({
      workspaceIds,
      requestedTeamspaceId: scope.requestedTeamspaceId,
      target: pageScopeIds ? "page_subtree_search" : "workspace_search",
      source: pageScopeWorkspaceId ? "page_url_workspace" : scope.source,
      pageScopeWorkspaceId,
    });
    return okJson(notionSearchResponse(
      results,
      "workspace_search",
      content_search_mode === "ai_search"
        ? {
            ...scopeExtra,
            requested_content_search_mode: "ai_search",
            effective_content_search_mode: "workspace_search",
            unsupported_features: ["notion_ai_search", "connected_source_search"],
            note: "Hanji does not provide a separate AI or connected-source search layer; searched account-accessible Hanji workspace data using the scope metadata above.",
          }
        : scopeExtra
    ));
  } catch (e) {
    return fail(e);
  }
}

const NOTION_SEARCH_TOOL = {
  title: "Search",
  description:
    "Notion-compatible search for Hanji. Hanji MCP is account-scoped, so workspace_id is required. Call list_workspaces or _notion_get_teams first, choose one Hanji workspace id, and pass it as workspace_id or Notion-compatible teamspace_id.",
  inputSchema: NOTION_SEARCH_INPUT_SCHEMA,
};

registerToolAliases(["search", "_search"], NOTION_SEARCH_TOOL, handleNotionSearch);

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
    const isCollection = /^collection:\/\//i.test(String(id ?? "").trim());
    const entityId = stripHanjiId(id);
    const page = await eb.getOne("pages", entityId);
    if (!page || !page.id) throw new Error(`Page or data source ${id} not found.`);
    const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, page, "_fetch", "Page or data source");
    if (matched.errorResult) return matched.errorResult;
    const payload = isCollection || page.kind === "database"
      ? await notionDataSourceFetchPayload(page)
      : await notionPageFetchPayload(page, include_discussions);
    if (!include_transcript) return okJson(payload);
    // Mirror the meeting-notes stub: declare the transcript layer unsupported
    // explicitly instead of silently dropping the flag.
    return okJson({
      ...payload,
      transcript: null,
      unsupported_feature: "notion_ai_meeting_transcripts",
      transcript_note:
        "Hanji does not provide a separate Notion AI meeting-notes/transcript data source; include_transcript was ignored.",
    });
  } catch (e) {
    return fail(e);
  }
}

const NOTION_FETCH_TOOL = {
  title: "Fetch",
  description:
    "Notion-compatible fetch for Hanji pages, databases, and collection:// data sources. Hanji MCP is account-scoped, so workspace_id is required. Returns JSON text with metadata/title/url/text, using enhanced Notion-style Markdown tags such as <page>, <database>, <data-source>, and <sqlite-table>.",
  inputSchema: NOTION_FETCH_INPUT_SCHEMA,
};

registerToolAliases(["fetch", "_fetch"], NOTION_FETCH_TOOL, handleNotionFetch);

server.registerTool(
  "list_workspaces",
  {
    title: "List workspaces",
    description:
      "List all Hanji workspaces accessible to the current account-scoped MCP user. Use a returned workspace id as Notion-compatible teamspace_id to narrow Notion-style tools.",
    inputSchema: {},
    outputSchema: MCP_LIST_WORKSPACES_OUTPUT_SCHEMA,
  },
  async () => {
    try {
      const result = { workspaces: await accountAccessibleWorkspaces() };
      return okStructured(workspaceLines(result).join("\n"), workspaceStructuredContent(result));
    } catch (e) {
      return fail(e);
    }
  }
);

const NOTION_GET_USERS_TOOL = {
  title: "Get users",
  description:
    "Notion-compatible user listing. Hanji is account-scoped, so workspace_id is required and this returns members from the selected workspace with cursor pagination.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    user_id: z.string().optional().describe("Specific user id, or self for the first accessible member"),
    query: z.string().optional(),
    start_cursor: z.string().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  },
};

async function handleNotionGetUsers({ workspace_id, teamspace_id, user_id, query, start_cursor, page_size = 100 }) {
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_get_users");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const workspaces = [{ id: requiredWorkspace.workspaceId }];
    const users = [];
    const seen = new Set();
    const needle = String(query ?? "").trim().toLowerCase();
    for (const workspace of workspaces) {
      const members = await eb.workspaceMembers(workspace.id);
      for (const member of members.members ?? []) {
        const id = member.userId || member.id;
        if (!id || seen.has(id)) continue;
        const label = workspaceMemberLabel(member);
        const email = member.email ?? "";
        if (needle && !`${label}\n${email}\n${id}`.toLowerCase().includes(needle)) continue;
        seen.add(id);
        users.push({
          type: "person",
          id,
          name: label,
          email: email || undefined,
          workspace_id: workspace.id,
        });
      }
    }
    const filtered = user_id && user_id !== "self"
      ? users.filter((user) => user.id === user_id)
      : user_id === "self"
        ? users.slice(0, 1)
        : users;
    const start = Math.max(0, Number.parseInt(start_cursor ?? "0", 10) || 0);
    const selected = filtered.slice(start, start + clamp(page_size, 1, 100));
    return okJson({
      results: selected,
      has_more: start + selected.length < filtered.length,
      next_cursor: start + selected.length < filtered.length ? String(start + selected.length) : null,
    });
  } catch (e) {
    return fail(e);
  }
}

registerToolAliases(["get_users", "_notion_get_users"], NOTION_GET_USERS_TOOL, handleNotionGetUsers);

server.registerTool(
  "_notion_get_teams",
  {
    title: "Get teams",
    description:
      "Notion-compatible teamspace listing. Hanji does not have separate Notion teamspaces, so this returns account-accessible workspaces as teamspace-compatible objects.",
    inputSchema: {
      query: z.string().optional(),
    },
  },
  async ({ query }) => {
    try {
      const workspaces = await accountAccessibleWorkspaces();
      const needle = String(query ?? "").trim().toLowerCase();
      const teams = workspaces
        .filter((workspace) => !needle || String(workspace.name ?? "").toLowerCase().includes(needle))
        .slice(0, 10)
        .map((workspace) => ({
          id: workspace.id,
          teamspace_id: workspace.id,
          workspace_id: workspace.id,
          name: workspace.name || workspace.domain || "Workspace",
          type: "workspace_as_teamspace",
          scope_model: "hanji_account_workspace",
          membership_status: "member",
          role: workspace.role ?? workspace.membershipRole ?? "member",
        }));
      return okJson({
        results: teams,
        joined: teams,
        available: [],
        has_more: false,
        provider_scope_model: "hanji_account_accessible_workspaces",
        teamspace_id_alias: "Hanji workspace_id",
        note:
          "Hanji maps Notion teamspaces to accessible workspaces. Choose one of these ids and pass it as workspace_id or teamspace_id; workspace-bound compatible tools reject calls that omit a workspace id.",
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "_notion_query_meeting_notes",
  {
    title: "Query meeting notes",
    description:
      "Notion-compatible meeting notes query stub. Hanji MCP is account-scoped, so workspace_id is required, but Hanji does not provide a separate AI meeting-notes data source.",
    inputSchema: {
      workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
      teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
      filter: JsonValueSchema.optional(),
    },
  },
  async ({ workspace_id, teamspace_id }) => {
    try {
      const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_query_meeting_notes");
      if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
      return okJson({
        results: [],
        has_more: false,
        next_cursor: null,
        is_unsupported: true,
        unsupported_feature: "notion_ai_meeting_notes",
        workspace_id: requiredWorkspace.workspaceId,
        message:
          "Hanji does not provide a separate Notion AI meeting-notes data source. Use normal page/database search or a Hanji database dedicated to meetings.",
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_organizations",
  {
    title: "List organizations",
    description:
      "List organizations/accounts accessible to the current MCP user through the backend workspace API.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await eb.listOrganizations();
      return ok(organizationLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "get_organization_directory",
  {
    title: "Get organization directory",
    description:
      "List organization/account members and workspaces through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      auditAction: z.string().optional().describe("Optional exact organization audit event action filter"),
      auditTargetType: z.string().optional().describe("Optional exact organization audit target type filter"),
      auditLimit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ organizationId, auditAction, auditTargetType, auditLimit }) => {
    try {
      const result = await eb.organizationDirectory({
        organizationId,
        auditAction,
        auditTargetType,
        auditLimit,
      });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_organization_people",
  {
    title: "Search organization people",
    description:
      "Search organization people profiles through the backend product API for mentions, sharing, and admin workflows.",
    inputSchema: {
      organizationId: z.string(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      includeInvited: z.boolean().optional(),
      includeDeactivated: z.boolean().optional(),
    },
  },
  async ({ organizationId, query, limit, includeInvited, includeDeactivated }) => {
    try {
      const result = await eb.searchOrganizationPeople({
        organizationId,
        query,
        limit,
        includeInvited,
        includeDeactivated,
      });
      return ok(organizationPeopleSearchLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "update_organization_settings",
  {
    title: "Update organization settings",
    description:
      "Update organization/account policy settings through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      workspaceCreationPolicy: z
        .enum(["owners_admins", "members"])
        .optional()
        .describe("Who can create workspaces in this organization"),
      domainSignupPolicy: z
        .enum(["invite_only", "verified_domains"])
        .optional()
        .describe("Whether organization members must use verified organization email domains"),
      publicWebSharing: z.boolean().optional(),
      externalEmailSharing: z.boolean().optional(),
      guestAccess: z.boolean().optional(),
      fileDownloads: z.boolean().optional(),
      fullAccessGrants: z.boolean().optional(),
      storageLimitBytes: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional()
        .describe("Organization storage limit in bytes. Pass null to remove the limit."),
    },
  },
  async ({
    organizationId,
    workspaceCreationPolicy,
    domainSignupPolicy,
    publicWebSharing,
    externalEmailSharing,
    guestAccess,
    fileDownloads,
    fullAccessGrants,
    storageLimitBytes,
  }) => {
    try {
      const sharingPolicy = {};
      if (publicWebSharing !== undefined) sharingPolicy.publicWebSharing = publicWebSharing;
      if (externalEmailSharing !== undefined) sharingPolicy.externalEmailSharing = externalEmailSharing;
      if (guestAccess !== undefined) sharingPolicy.guestAccess = guestAccess;
      if (fileDownloads !== undefined) sharingPolicy.fileDownloads = fileDownloads;
      if (fullAccessGrants !== undefined) sharingPolicy.fullAccessGrants = fullAccessGrants;
      const result = await eb.updateOrganizationSettings({
        organizationId,
        workspaceCreationPolicy,
        domainSignupPolicy,
        ...(storageLimitBytes !== undefined ? { storageLimitBytes } : {}),
        ...(Object.keys(sharingPolicy).length ? { sharingPolicy } : {}),
      });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "transfer_organization_owner",
  {
    title: "Transfer organization owner",
    description:
      "Transfer organization ownership to an active organization member through the backend workspace API. The previous owner remains an organization admin.",
    inputSchema: {
      organizationId: z.string(),
      organizationMemberId: z.string().optional(),
      userId: z.string().optional(),
    },
  },
  async ({ organizationId, organizationMemberId, userId }) => {
    try {
      if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
      const result = await eb.transferOrganizationOwner({ organizationId, organizationMemberId, userId });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "deactivate_organization_member",
  {
    title: "Deactivate organization member",
    description:
      "Deactivate an organization member through the backend workspace API. Deactivated members cannot bootstrap into organization workspaces.",
    inputSchema: {
      organizationId: z.string(),
      organizationMemberId: z.string().optional(),
      userId: z.string().optional(),
    },
  },
  async ({ organizationId, organizationMemberId, userId }) => {
    try {
      if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
      const result = await eb.deactivateOrganizationMember({ organizationId, organizationMemberId, userId });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "reactivate_organization_member",
  {
    title: "Reactivate organization member",
    description:
      "Reactivate an organization member through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      organizationMemberId: z.string().optional(),
      userId: z.string().optional(),
    },
  },
  async ({ organizationId, organizationMemberId, userId }) => {
    try {
      if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
      const result = await eb.reactivateOrganizationMember({ organizationId, organizationMemberId, userId });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "remove_organization_member",
  {
    title: "Remove organization member",
    description:
      "Remove an organization member from the account through the backend workspace API. This also reassigns their page/block/comment/file ownership metadata to an active non-guest organization member, removes organization workspace memberships, revokes pending invitations for the same email, and removes direct page permissions in the organization. Workspace owners must transfer ownership first.",
    inputSchema: {
      organizationId: z.string(),
      organizationMemberId: z.string().optional(),
      userId: z.string().optional(),
      reassignToOrganizationMemberId: z.string().optional(),
      reassignToUserId: z.string().optional(),
    },
  },
  async ({ organizationId, organizationMemberId, userId, reassignToOrganizationMemberId, reassignToUserId }) => {
    try {
      if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
      const result = await eb.removeOrganizationMember({
        organizationId,
        organizationMemberId,
        userId,
        reassignToOrganizationMemberId,
        reassignToUserId,
      });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "create_organization_group",
  {
    title: "Create organization group",
    description:
      "Create a reusable organization group/team through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
    },
  },
  async ({ organizationId, name, description }) => {
    try {
      const result = await eb.createOrganizationGroup({ organizationId, name, description });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "update_organization_group",
  {
    title: "Update organization group",
    description:
      "Rename or update a reusable organization group/team through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      organizationGroupId: z.string().optional(),
      name: z.string().optional(),
      currentName: z.string().optional(),
      description: z.string().nullable().optional(),
    },
  },
  async ({ organizationId, organizationGroupId, name, currentName, description }) => {
    try {
      if (!organizationGroupId && !currentName) throw new Error("Provide organizationGroupId or currentName.");
      if (name === undefined && description === undefined) {
        throw new Error("Provide name or description.");
      }
      const result = await eb.updateOrganizationGroup({
        organizationId,
        organizationGroupId,
        currentName,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "delete_organization_group",
  {
    title: "Delete organization group",
    description:
      "Delete an organization group/team through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      organizationGroupId: z.string().optional(),
      name: z.string().optional(),
    },
  },
  async ({ organizationId, organizationGroupId, name }) => {
    try {
      if (!organizationGroupId && !name) throw new Error("Provide organizationGroupId or name.");
      const result = await eb.deleteOrganizationGroup({ organizationId, organizationGroupId, name });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "add_organization_group_member",
  {
    title: "Add organization group member",
    description:
      "Add an active organization member to an organization group/team through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      organizationGroupId: z.string().optional(),
      name: z.string().optional(),
      organizationMemberId: z.string().optional(),
      userId: z.string().optional(),
    },
  },
  async ({ organizationId, organizationGroupId, name, organizationMemberId, userId }) => {
    try {
      if (!organizationGroupId && !name) throw new Error("Provide organizationGroupId or name.");
      if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
      const result = await eb.addOrganizationGroupMember({
        organizationId,
        organizationGroupId,
        name,
        organizationMemberId,
        userId,
      });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "remove_organization_group_member",
  {
    title: "Remove organization group member",
    description:
      "Remove a member from an organization group/team through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      organizationGroupId: z.string().optional(),
      name: z.string().optional(),
      organizationGroupMemberId: z.string().optional(),
      organizationMemberId: z.string().optional(),
      userId: z.string().optional(),
    },
  },
  async ({
    organizationId,
    organizationGroupId,
    name,
    organizationGroupMemberId,
    organizationMemberId,
    userId,
  }) => {
    try {
      if (!organizationGroupId && !name) throw new Error("Provide organizationGroupId or name.");
      if (!organizationGroupMemberId && !organizationMemberId && !userId) {
        throw new Error("Provide organizationGroupMemberId, organizationMemberId, or userId.");
      }
      const result = await eb.removeOrganizationGroupMember({
        organizationId,
        organizationGroupId,
        name,
        organizationGroupMemberId,
        organizationMemberId,
        userId,
      });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "add_organization_domain",
  {
    title: "Add organization domain",
    description:
      "Add a pending organization email domain through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      domain: z.string(),
    },
  },
  async ({ organizationId, domain }) => {
    try {
      const result = await eb.addOrganizationDomain({ organizationId, domain });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "verify_organization_domain",
  {
    title: "Verify organization domain",
    description:
      "Mark an organization domain verified through the backend workspace API. This is a manual verification placeholder for local/product administration.",
    inputSchema: {
      organizationId: z.string(),
      organizationDomainId: z.string().optional(),
      domain: z.string().optional(),
    },
  },
  async ({ organizationId, organizationDomainId, domain }) => {
    try {
      if (!organizationDomainId && !domain) throw new Error("Provide organizationDomainId or domain.");
      const result = await eb.verifyOrganizationDomain({ organizationId, organizationDomainId, domain });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "remove_organization_domain",
  {
    title: "Remove organization domain",
    description:
      "Remove an organization domain through the backend workspace API.",
    inputSchema: {
      organizationId: z.string(),
      organizationDomainId: z.string().optional(),
      domain: z.string().optional(),
    },
  },
  async ({ organizationId, organizationDomainId, domain }) => {
    try {
      if (!organizationDomainId && !domain) throw new Error("Provide organizationDomainId or domain.");
      const result = await eb.removeOrganizationDomain({ organizationId, organizationDomainId, domain });
      return ok(organizationMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "create_workspace",
  {
    title: "Create workspace",
    description:
      "Create a new owner workspace through the backend workspace API. The MCP current workspace is not switched automatically.",
    inputSchema: {
      name: z.string().min(1),
      icon: z.string().optional(),
      domain: z.string().optional().describe("Optional workspace URL slug"),
      organizationId: z.string().optional().describe("Optional organization/account id"),
    },
  },
  async ({ name, icon, domain, organizationId }) => {
    try {
      const result = await eb.createWorkspace({ name, icon, domain, organizationId });
      return ok(workspaceLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "delete_workspace",
  {
    title: "Delete workspace",
    description:
      "Delete an owner-only empty workspace through the backend workspace API. Populated workspaces are rejected until full workspace archival is implemented.",
    inputSchema: {
      workspaceId: z.string(),
    },
  },
  async ({ workspaceId }) => {
    try {
      const result = await eb.deleteWorkspace(workspaceId);
      return ok(workspaceLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_workspace_members",
  {
    title: "List workspace members",
    description: "List workspace members through the backend workspace API.",
    inputSchema: {
      workspaceId: z.string().optional(),
    },
  },
  async ({ workspaceId }) => {
    try {
      const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
      const result = await eb.workspaceMembers(workspace.id);
      return ok(workspaceMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "add_workspace_member",
  {
    title: "Add workspace member",
    description:
      "Add an existing server account to a workspace, or update an existing workspace member, through the backend workspace API. An unknown email is handled as a blind no-op so this tool cannot be used to discover whether an account exists.",
    inputSchema: {
      workspaceId: z.string().optional(),
      userId: z.string().optional().describe("Known EdgeBase user id to add to the workspace"),
      displayName: z.string().optional(),
      email: z.string().optional().describe("Exact email of an existing server account when userId is not known"),
      role: z.enum(WORKSPACE_MEMBER_ROLES).optional(),
    },
  },
  async ({ workspaceId, userId, displayName, email, role }) => {
    try {
      if (!userId && !email) throw new Error("Provide userId or email.");
      const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
      const result = await eb.addWorkspaceMember({
        workspaceId: workspace.id,
        userId,
        displayName,
        email,
        role,
      });
      return ok(workspaceMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "update_my_workspace_profile",
  {
    title: "Update my workspace profile",
    description:
      "Update the current user's workspace display name or email through the backend workspace API.",
    inputSchema: {
      workspaceId: z.string().optional(),
      displayName: z.string().optional(),
      email: z.string().optional(),
    },
  },
  async ({ workspaceId, displayName, email }) => {
    try {
      if (displayName === undefined && email === undefined) {
        throw new Error("Provide displayName or email.");
      }
      const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
      const result = await eb.updateMyWorkspaceProfile({
        workspaceId: workspace.id,
        displayName,
        email,
      });
      return ok(workspaceMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "update_workspace_member_role",
  {
    title: "Update workspace member role",
    description: "Change a workspace member role through the backend workspace API.",
    inputSchema: {
      workspaceId: z.string().optional(),
      memberId: z.string().optional(),
      userId: z.string().optional(),
      role: z.enum(WORKSPACE_MEMBER_ROLES),
    },
  },
  async ({ workspaceId, memberId, userId, role }) => {
    try {
      if (!memberId && !userId) throw new Error("Provide memberId or userId.");
      const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
      const result = await eb.updateWorkspaceMemberRole({
        workspaceId: workspace.id,
        memberId,
        userId,
        role,
      });
      return ok(workspaceMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "transfer_workspace_owner",
  {
    title: "Transfer workspace owner",
    description:
      "Transfer workspace ownership to another existing workspace member through the backend workspace API. The previous owner remains a workspace admin.",
    inputSchema: {
      workspaceId: z.string().optional(),
      memberId: z.string().optional(),
      userId: z.string().optional(),
    },
  },
  async ({ workspaceId, memberId, userId }) => {
    try {
      if (!memberId && !userId) throw new Error("Provide memberId or userId.");
      const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
      const result = await eb.transferWorkspaceOwner({
        workspaceId: workspace.id,
        memberId,
        userId,
      });
      return ok(workspaceMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "remove_workspace_member",
  {
    title: "Remove workspace member",
    description: "Remove a user from the workspace through the backend workspace API.",
    inputSchema: {
      workspaceId: z.string().optional(),
      memberId: z.string().optional(),
      userId: z.string().optional(),
    },
  },
  async ({ workspaceId, memberId, userId }) => {
    try {
      if (!memberId && !userId) throw new Error("Provide memberId or userId.");
      const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
      const result = await eb.removeWorkspaceMember({
        workspaceId: workspace.id,
        memberId,
        userId,
      });
      return ok(workspaceMemberLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_pages",
  {
    title: "Search pages",
    description: "Full-text search page titles. Returns matching pages with their ids.",
    inputSchema: {
      query: z.string().describe("Search text"),
      workspaceId: z.string().optional().describe("Optional workspace id to search within"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum pages to return"),
    },
  },
  async ({ query, workspaceId, limit }) => {
    try {
      const hits = await eb.searchPages(query, { workspaceId, limit });
      if (hits.length === 0) return ok(`No pages match "${query}".`);
      return ok(hits.map((p) => `- ${titleOf(p)}  (id: ${p.id})`).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "search_blocks",
  {
    title: "Search blocks",
    description:
      "Full-text search page body blocks through the product API. Returns only blocks visible to the current MCP user.",
    inputSchema: {
      query: z.string().describe("Search text"),
      workspaceId: z.string().optional().describe("Optional workspace id to search within"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum blocks to return"),
    },
  },
  async ({ query, workspaceId, limit }) => {
    try {
      const hits = await eb.searchBlocks(query, { workspaceId, limit });
      if (hits.length === 0) return ok(`No blocks match "${query}".`);
      return ok(
        hits
          .map((block) =>
            `- ${blockPreview(block)}  (page id: ${block.pageId}, block id: ${block.id}, type: ${block.type})`
          )
          .join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_pages",
  {
    title: "List pages",
    description:
      "List pages. With no parentId, lists top-level pages. With a parentId, lists that page's sub-pages.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Optional workspace id; defaults to the current workspace"),
      parentId: z.string().optional().describe("Parent page id; omit for top-level pages"),
    },
  },
  async ({ workspaceId, parentId }) => {
    try {
      const all = await eb.pageProjection({ workspaceId });
      const children = all.filter((p) =>
        parentId ? p.parentId === parentId : p.parentType === "workspace" || p.parentId == null
      );
      if (children.length === 0) return ok("No pages here.");
      return ok(
        children
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map((p) => {
            const kids = all.filter((c) => c.parentId === p.id).length;
            return `- ${titleOf(p)}${p.kind === "database" ? " [database]" : ""}${
              kids ? ` (${kids} sub-pages)` : ""
            }  (id: ${p.id})`;
          })
          .join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

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

server.registerTool(
  "import_markdown_page",
  {
    title: "Import Markdown page",
    description:
      "Import Markdown as a Hanji page through the backend product API. Supports headings, lists, to-dos, quotes, code, and nested list indentation.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      parentId: z.string().optional().describe("Parent page/database id; omit for workspace root"),
      parentType: z.enum(PAGE_PARENT_TYPES).optional().describe("Parent type; defaults to page when parentId is set, otherwise workspace"),
      title: z.string().optional().describe("Imported page title"),
      position: z.number().optional().describe("Optional sibling position"),
      markdown: z.string().describe("Markdown body to import"),
    },
  },
  async ({ workspaceId, parentId, parentType, title, position, markdown }) => {
    try {
      const result = await eb.importMarkdownPage({
        workspaceId,
        parentId,
        parentType,
        title,
        position,
        markdown,
      });
      const page = result.page ?? {};
      return ok(
        `Imported Markdown page "${titleOf(page)}".\n` +
          `page id: ${page.id}\n` +
          `blocks: ${result.count ?? result.blocks?.length ?? 0}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "import_csv_database",
  {
    title: "Import CSV database",
    description:
      "Import CSV as a typed Hanji database through the backend product API. The first row is used as headers and column types are inferred.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      parentId: z.string().optional().describe("Parent page id; omit for workspace root"),
      parentType: z.enum(["workspace", "page"]).optional().describe("Parent type; defaults to page when parentId is set, otherwise workspace"),
      title: z.string().optional().describe("Imported database title"),
      position: z.number().optional().describe("Optional sibling position"),
      csv: z.string().describe("CSV text to import"),
    },
  },
  async ({ workspaceId, parentId, parentType, title, position, csv }) => {
    try {
      const result = await eb.importCsvDatabase({
        workspaceId,
        parentId,
        parentType,
        title,
        position,
        csv,
      });
      const page = result.page ?? {};
      const props = Array.isArray(result.properties) ? result.properties : [];
      const propText = props.length ? props.map(schemaLine).join("\n") : "_No properties_";
      return ok(
        `Imported CSV database "${titleOf(page)}".\n` +
          `database id: ${page.id}\n` +
          `rows: ${result.count ?? result.rows?.length ?? 0}\n\n` +
          `## Properties\n${propText}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "begin_notion_oauth_connection",
  {
    title: "Begin Notion OAuth connection",
    description:
      "Create a signed Notion OAuth authorization URL for a Hanji workspace. Open the URL in a browser, then complete with the returned code and state.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      name: z.string().optional().describe("Human-readable connection name to store after OAuth completes"),
      redirectUri: z.string().describe("Redirect URI registered in the Notion public connection settings"),
    },
  },
  async ({ workspaceId, name, redirectUri }) => {
    try {
      const result = await eb.beginNotionOAuthConnection({ workspaceId, name, redirectUri });
      return ok(
        `authorization url: ${result.authorizationUrl ?? ""}` +
          `\nredirect uri: ${result.redirectUri ?? ""}` +
          `\nexpires at: ${result.expiresAt ?? ""}` +
          `\nstate: ${result.state ?? ""}`,
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "complete_notion_oauth_connection",
  {
    title: "Complete Notion OAuth connection",
    description:
      "Exchange a Notion OAuth callback code and signed state for an encrypted Notion import connection.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      code: z.string().describe("Authorization code returned by Notion"),
      state: z.string().describe("Signed state returned by Notion"),
      redirectUri: z.string().optional().describe("Redirect URI used in the authorization request"),
      name: z.string().optional().describe("Optional connection name override"),
    },
  },
  async ({ workspaceId, code, state, redirectUri, name }) => {
    try {
      const result = await eb.completeNotionOAuthConnection({ workspaceId, code, state, redirectUri, name });
      return ok(notionImportConnectionSummary(result.connection));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "create_notion_import_connection",
  {
    title: "Create Notion import connection",
    description:
      "Store an encrypted Notion API connection for a Hanji workspace. Requires the backend HANJI_NOTION_IMPORT_SECRET to be configured.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      name: z.string().optional().describe("Human-readable connection name"),
      connectionKind: z.enum(NOTION_IMPORT_CONNECTION_KINDS).optional().describe("Notion connection kind"),
      notionToken: z.string().describe("Notion API token to validate and store encrypted on the backend"),
    },
  },
  async ({ workspaceId, name, connectionKind, notionToken }) => {
    try {
      const result = await eb.createNotionImportConnection({
        workspaceId,
        name,
        connectionKind,
        notionToken,
      });
      return ok(notionImportConnectionSummary(result.connection));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_notion_import_connections",
  {
    title: "List Notion import connections",
    description: "List stored Notion API import connections for a Hanji workspace without exposing credentials.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      limit: z.number().optional().describe("Maximum number of connections to return"),
    },
  },
  async ({ workspaceId, limit }) => {
    try {
      const result = await eb.listNotionImportConnections({ workspaceId, limit });
      const connections = Array.isArray(result.connections) ? result.connections : [];
      if (connections.length === 0) return ok("No Notion import connections.");
      return ok(connections.map(notionImportConnectionSummary).join("\n\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "revoke_notion_import_connection",
  {
    title: "Revoke Notion import connection",
    description: "Revoke a stored Notion API import connection and remove its encrypted credential.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      connectionId: z.string().describe("Notion import connection id"),
    },
  },
  async ({ workspaceId, connectionId }) => {
    try {
      const result = await eb.revokeNotionImportConnection({ workspaceId, connectionId });
      return ok(notionImportConnectionSummary(result.connection));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "create_notion_import_job",
  {
    title: "Create Notion API import job",
    description:
      "Create a Notion API import job through the Hanji product API. When a Notion token is provided, the backend performs the first accessible workspace discovery pass without storing the token.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      parentPageId: z.string().optional().describe("Optional Hanji parent page id for imported content"),
      connectionKind: z.enum(NOTION_IMPORT_CONNECTION_KINDS).optional().describe("Notion connection kind"),
      connectionId: z.string().optional().describe("Stored Notion import connection id for discovery"),
      notionToken: z.string().optional().describe("Optional Notion API token for immediate discovery; not stored"),
      rootNotionPageIds: z.array(z.string()).optional().describe("Optional Notion root page ids to prioritize"),
      snapshotItems: z.array(JsonObjectSchema).optional().describe("Optional pre-fetched Notion API graph snapshot items"),
      maxDiscoveryPages: z.number().optional().describe("Number of Notion search pages to scan, max 20"),
      maxEnrichedItems: z.number().optional().describe("Number of discovered search items to enrich with graph snapshots, max 50"),
      maxChildrenPages: z.number().optional().describe("Number of block-children pages to read per Notion page, max 3"),
      maxDataSourceQueryPages: z.number().optional().describe("Number of data source query pages to read per data source, max 2"),
      maxViewPages: z.number().optional().describe("Number of view-list pages to read per data source, max 3"),
      copyFilesToStorage: z.boolean().optional().describe("Whether apply should copy imported Notion file references into EdgeBase storage. Defaults to true."),
    },
  },
  async ({
    workspaceId,
    parentPageId,
    connectionKind,
    connectionId,
    notionToken,
    rootNotionPageIds,
    snapshotItems,
    maxDiscoveryPages,
    maxEnrichedItems,
    maxChildrenPages,
    maxDataSourceQueryPages,
    maxViewPages,
    copyFilesToStorage,
  }) => {
    try {
      const result = await eb.createNotionImportJob({
        workspaceId,
        parentPageId,
        connectionKind,
        connectionId,
        notionToken,
        rootNotionPageIds,
        snapshotItems,
        maxDiscoveryPages,
        maxEnrichedItems,
        maxChildrenPages,
        maxDataSourceQueryPages,
        maxViewPages,
        copyFilesToStorage,
      });
      return ok(notionImportJobSummary(result.job) + notionImportItemPreview(result.items));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_notion_import_jobs",
  {
    title: "List Notion import jobs",
    description: "List recent Notion API import jobs for a Hanji workspace.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      limit: z.number().optional().describe("Maximum number of jobs to return"),
    },
  },
  async ({ workspaceId, limit }) => {
    try {
      const result = await eb.listNotionImportJobs({ workspaceId, limit });
      const jobs = Array.isArray(result.jobs) ? result.jobs : [];
      if (jobs.length === 0) return ok("No Notion import jobs.");
      return ok(jobs.map(notionImportJobSummary).join("\n\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "get_notion_import_job",
  {
    title: "Get Notion import job",
    description: "Inspect a Notion API import job and its discovered Notion items.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      jobId: z.string().describe("Notion import job id"),
    },
  },
  async ({ workspaceId, jobId }) => {
    try {
      const result = await eb.getNotionImportJob({ workspaceId, jobId });
      return ok(notionImportJobSummary(result.job) + notionImportItemPreview(result.items));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "plan_notion_import_job",
  {
    title: "Review Notion import job",
    description:
      "Dry-run a ready Notion API import job and return estimated local writes plus conversion issues before applying it.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      jobId: z.string().describe("Ready Notion import job id"),
    },
  },
  async ({ workspaceId, jobId }) => {
    try {
      const result = await eb.planNotionImportJob({ workspaceId, jobId });
      return ok(notionImportJobSummary(result.job) + "\n\n" + notionImportPlanSummary(result.plan));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "discover_notion_import_job",
  {
    title: "Discover Notion import graph",
    description:
      "Run the Notion API discovery pass for an existing import job with a one-time token or stored connection id.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      jobId: z.string().describe("Notion import job id"),
      notionToken: z.string().optional().describe("One-time Notion API token; not stored"),
      connectionId: z.string().optional().describe("Stored Notion import connection id"),
      maxDiscoveryPages: z.number().optional().describe("Number of Notion search pages to scan, max 20"),
      maxEnrichedItems: z.number().optional().describe("Number of discovered search items to enrich with graph snapshots, max 50"),
      maxChildrenPages: z.number().optional().describe("Number of block-children pages to read per Notion page, max 3"),
      maxDataSourceQueryPages: z.number().optional().describe("Number of data source query pages to read per data source, max 2"),
      maxViewPages: z.number().optional().describe("Number of view-list pages to read per data source, max 3"),
      continueFromCursor: z.boolean().optional().describe("Continue from the job's saved Notion search cursor and merge newly discovered items instead of replacing the graph"),
    },
  },
  async ({
    workspaceId,
    jobId,
    notionToken,
    connectionId,
    maxDiscoveryPages,
    maxEnrichedItems,
    maxChildrenPages,
    maxDataSourceQueryPages,
    maxViewPages,
    continueFromCursor,
  }) => {
    try {
      const result = await eb.discoverNotionImportJob({
        workspaceId,
        jobId,
        notionToken,
        connectionId,
        maxDiscoveryPages,
        maxEnrichedItems,
        maxChildrenPages,
        maxDataSourceQueryPages,
        maxViewPages,
        continueFromCursor,
      });
      return ok(notionImportJobSummary(result.job) + notionImportItemPreview(result.items));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "cancel_notion_import_job",
  {
    title: "Cancel Notion import job",
    description: "Cancel a queued or active Notion API import job.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      jobId: z.string().describe("Notion import job id"),
    },
  },
  async ({ workspaceId, jobId }) => {
    try {
      const result = await eb.cancelNotionImportJob({ workspaceId, jobId });
      return ok(notionImportJobSummary(result.job));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "apply_notion_import_job",
  {
    title: "Apply Notion import job",
    description:
      "Apply a ready Notion API import job into local Hanji pages, canonical databases, views, rows, blocks, file uploads, and durable mappings.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      jobId: z.string().describe("Ready Notion import job id"),
    },
  },
  async ({ workspaceId, jobId }) => {
    try {
      const result = await eb.applyNotionImportJob({ workspaceId, jobId });
      const applied = result.applied ?? {};
      return ok(
        notionImportJobSummary(result.job) +
          `\n\napplied pages: ${applied.pages ?? 0}` +
          `\napplied databases: ${applied.databases ?? 0}` +
          `\napplied rows: ${applied.rows ?? 0}` +
          `\napplied properties: ${applied.properties ?? 0}` +
          `\napplied views: ${applied.views ?? 0}` +
          `\napplied blocks: ${applied.blocks ?? 0}` +
          `\nfile copies: ${applied.fileCopies ?? 0}` +
          `\nfile copy skipped: ${applied.fileCopySkipped ?? 0}`,
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "retry_notion_import_file_copies",
  {
    title: "Retry Notion import file copies",
    description:
      "Retry copying skipped Notion file references from a completed import job into EdgeBase storage without creating a new import job.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      jobId: z.string().describe("Completed Notion import job id"),
    },
  },
  async ({ workspaceId, jobId }) => {
    try {
      const result = await eb.retryNotionImportFileCopies({ workspaceId, jobId });
      const retry = result.fileRetry ?? {};
      return ok(
        notionImportJobSummary(result.job) +
          `\n\nfile references scanned: ${retry.scanned ?? 0}` +
          `\nfile copies: ${retry.copied ?? 0}` +
          `\nfile copy skipped: ${retry.skipped ?? 0}`,
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "retry_notion_import_job",
  {
    title: "Retry Notion import job",
    description:
      "Create a retry job from a previous Notion API import job. Provide a token to run discovery immediately.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      jobId: z.string().describe("Previous Notion import job id"),
      notionToken: z.string().optional().describe("Optional Notion API token for immediate discovery; not stored"),
      connectionId: z.string().optional().describe("Optional stored Notion import connection id for immediate discovery"),
      maxDiscoveryPages: z.number().optional().describe("Number of Notion search pages to scan, max 20"),
      maxEnrichedItems: z.number().optional().describe("Number of discovered search items to enrich with graph snapshots, max 50"),
      maxChildrenPages: z.number().optional().describe("Number of block-children pages to read per Notion page, max 3"),
      maxDataSourceQueryPages: z.number().optional().describe("Number of data source query pages to read per data source, max 2"),
      maxViewPages: z.number().optional().describe("Number of view-list pages to read per data source, max 3"),
    },
  },
  async ({ workspaceId, jobId, notionToken, connectionId, maxDiscoveryPages, maxEnrichedItems, maxChildrenPages, maxDataSourceQueryPages, maxViewPages }) => {
    try {
      const result = await eb.retryNotionImportJob({
        workspaceId,
        jobId,
        notionToken,
        connectionId,
        maxDiscoveryPages,
        maxEnrichedItems,
        maxChildrenPages,
        maxDataSourceQueryPages,
        maxViewPages,
      });
      return ok(notionImportJobSummary(result.job) + notionImportItemPreview(result.items));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "export_page_markdown",
  {
    title: "Export page Markdown",
    description:
      "Export a page or database as Markdown through the backend product API. Database pages include a Markdown table of visible rows plus row-page body and child-page sections.",
    inputSchema: {
      pageId: z.string().describe("Page or database id to export"),
    },
  },
  async ({ pageId }) => {
    try {
      const result = await eb.exportPageMarkdown(pageId);
      const page = result.page ?? {};
      return ok(`Exported "${titleOf(page)}".\npage id: ${page.id}\n\n${result.markdown ?? ""}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "export_database_csv",
  {
    title: "Export database CSV",
    description:
      "Export a database as CSV through the backend product API. File properties include signed URLs when available.",
    inputSchema: {
      databaseId: z.string().describe("Database id to export"),
    },
  },
  async ({ databaseId }) => {
    try {
      const result = await eb.exportDatabaseCsv(databaseId);
      const page = result.page ?? {};
      return ok(
        `Exported CSV "${titleOf(page)}".\n` +
          `database id: ${page.id}\n` +
          `rows: ${result.rowCount ?? 0}\n\n` +
          `${result.csv ?? ""}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "export_workspace_markdown",
  {
    title: "Export workspace Markdown",
    description:
      "Export an accessible workspace page tree as Markdown through the backend product API. Includes nested pages, database tables, and database row-page sections.",
    inputSchema: {
      workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
    },
  },
  async ({ workspaceId }) => {
    try {
      const result = await eb.exportWorkspaceMarkdown({ workspaceId });
      const workspace = result.workspace ?? {};
      return ok(
        `Exported workspace "${workspace.name || workspace.domain || workspace.id || "unknown"}".\n` +
          `workspace id: ${workspace.id}\n` +
          `pages: ${result.pageCount ?? 0}\n\n` +
          `${result.markdown ?? ""}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

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

server.registerTool(
  "create_database",
  {
    title: "Create database",
    description:
      "Create a database page through the backend product API with default or custom properties, an initial view, and optional starter rows.",
    inputSchema: {
      title: z.string().optional().describe("Database title; defaults to Untitled"),
      parentId: z.string().optional().describe("Parent page id; omit for a top-level database"),
      parentType: z.enum(["workspace", "page"]).optional().describe("Destination type; defaults to page when parentId is set"),
      viewType: z.enum(DATABASE_VIEW_TYPES).optional().describe("Initial view type"),
      seedRows: z.boolean().optional().describe("Create three empty starter rows; default true"),
      properties: z.array(createDatabasePropertyInputSchema).optional().describe("Optional custom schema. If no title property is included, a title property is added automatically."),
    },
  },
  async ({ title, parentId, parentType, viewType = "table", seedRows = true, properties }) => {
    try {
      const { parentId: cleanParentId, parentType: cleanParentType } = normalizeParentInput(parentId, parentType);
      const result = await eb.createDatabase({
        parentId: cleanParentId,
        parentType: cleanParentType,
        title: title ?? "Untitled",
        viewType,
        seedRows,
        properties,
      });
      const db = result.page;
      const view = result.views?.[0];
      const props = result.properties ?? [];
      const rowCount = result.rows?.length ?? 0;

      return ok(
        `Created database "${titleOf(db)}".\n` +
          `database id: ${db.id}\n` +
          `view: ${view?.name ?? databaseViewLabel(viewType)} [${view?.type ?? viewType}] id: ${view?.id ?? "unknown"}\n` +
          `rows: ${rowCount}\n\n` +
          `## Properties\n${props.map(schemaLine).join("\n")}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "_notion_create_database",
  {
    title: "Create database",
    description:
      "Notion-compatible database creation using a SQL DDL CREATE TABLE schema. Hanji MCP is account-scoped, so workspace_id is required. Hanji creates one local data source per database.",
    inputSchema: {
      workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
      teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
      title: z.string().optional(),
      description: z.string().optional(),
      parent: z.object({
        type: z.string().optional(),
        page_id: z.string().optional(),
      }).optional(),
      schema: z.string().describe('CREATE TABLE statement, e.g. CREATE TABLE ("Name" TITLE, "Status" SELECT(...))'),
    },
  },
  async ({ workspace_id, teamspace_id, title, description, parent, schema }) => {
    try {
      const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_create_database");
      if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
      const properties = parseNotionCreateTableSchema(schema);
      const parentId = parent?.page_id ? stripHanjiId(parent.page_id) : null;
      if (parentId) {
        const parentPage = await eb.getOne("pages", parentId);
        if (!parentPage || !parentPage.id) throw new Error(`Parent page ${parentId} not found.`);
        const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, parentPage, "_notion_create_database", "Parent page");
        if (matched.errorResult) return matched.errorResult;
      }
      const result = await eb.createDatabase({
        workspaceId: requiredWorkspace.workspaceId,
        parentId,
        parentType: parentId ? "page" : "workspace",
        title: title ?? "Untitled",
        viewType: "table",
        seedRows: false,
        properties,
      });
      const payload = await notionDataSourceFetchPayload(result.page);
      const notes = description ? "\n\nNote: Hanji does not currently store a separate data-source description field." : "";
      return ok(`${payload.text}${notes}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_databases",
  {
    title: "List databases",
    description: "List local Hanji databases with ids and row counts.",
    inputSchema: {},
  },
  async () => {
    try {
      const databases = (await eb.pages()).filter((page) => page.kind === "database");
      if (databases.length === 0) return ok("No databases found.");
      const rowsByDb = await Promise.all(databases.map((db) => eb.dbRows(db.id)));
      const rowCounts = Object.fromEntries(databases.map((db, index) => [db.id, rowsByDb[index].length]));
      return ok(
        databases
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map((db) => `- ${titleOf(db)} (${rowCounts[db.id] ?? 0} rows)  id: ${db.id}`)
          .join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "describe_database",
  {
    title: "Describe database",
    description: "Read a database schema: properties, views, and row count.",
    inputSchema: { databaseId: z.string().describe("Database page id") },
    outputSchema: MCP_DESCRIBE_DATABASE_OUTPUT_SCHEMA,
  },
  async ({ databaseId }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") {
        const message = `Database ${databaseId} not found.`;
        return okStructured(message, describeDatabaseStructuredContent(null, [], [], [], message));
      }
      const [props, views, rows] = await Promise.all([
        eb.dbProperties(databaseId),
        eb.dbViews(databaseId),
        eb.dbRows(databaseId),
      ]);
      const propText = props.length ? props.map(schemaLine).join("\n") : "_No properties_";
      const viewText = views.length
        ? views.map((view) => viewLine(view, props)).join("\n")
        : "_No views_";
      return okStructured(
        `# ${titleOf(db)}\n` +
          `database id: ${db.id}\nrows: ${rows.length}\n\n` +
          `## Properties\n${propText}\n\n## Views\n${viewText}`,
        describeDatabaseStructuredContent(db, props, views, rows)
      );
    } catch (e) {
      return fail(e);
    }
  }
);

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

function normalizeNotionViewConfig(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const aliases = {
    visible_properties: "visibleProperties",
    property_order: "propertyOrder",
    wrapped_columns: "wrappedColumns",
    table_calculations: "tableCalculations",
    group_by: "groupBy",
    sub_group_by: "subGroupBy",
    calendar_by: "calendarBy",
    timeline_by: "timelineBy",
    timeline_end_by: "timelineEndBy",
    dependency_property: "dependencyProperty",
    cover_property: "coverProperty",
    card_size: "cardSize",
    open_page_in: "openPageIn",
    row_height: "rowHeight",
    timeline_zoom: "timelineZoom",
    filter_conjunction: "filterConjunction",
    filter_group: "filterGroup",
  };
  const normalized = { ...source };
  for (const [from, to] of Object.entries(aliases)) {
    if (normalized[to] === undefined && normalized[from] !== undefined) normalized[to] = normalized[from];
  }
  return normalized;
}

function parseQuotedList(value) {
  const text = String(value ?? "");
  const quoted = [...text.matchAll(/"([^"]+)"|'([^']+)'/g)].map((match) => match[1] ?? match[2]).filter(Boolean);
  if (quoted.length) return quoted;
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function splitTopLevel(input, separator = ",") {
  const parts = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (let index = 0; index < String(input ?? "").length; index += 1) {
    const ch = input[index];
    if (quote) {
      current += ch;
      if (ch === quote && input[index - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function firstQuoted(value) {
  const match = String(value ?? "").match(/"([^"]+)"|'([^']+)'/);
  return match?.[1] ?? match?.[2] ?? "";
}

function parseOptionNames(typeSpec) {
  const body = String(typeSpec ?? "").match(/\((.*)\)/s)?.[1] ?? "";
  return splitTopLevel(body).map((entry) => firstQuoted(entry) || entry.split(":")[0]?.trim()).filter(Boolean);
}

function parseNotionSqlColumnType(typeSpec, name = "Name") {
  const spec = String(typeSpec ?? "").trim();
  const upper = spec.toUpperCase();
  const description = spec.match(/\bCOMMENT\s+'([^']*)'/i)?.[1] ?? spec.match(/\bCOMMENT\s+"([^"]*)"/i)?.[1];
  const base = { name, description };
  if (!spec || upper.startsWith("RICH_TEXT") || upper.startsWith("TEXT")) return { ...base, type: "rich_text" };
  if (upper.startsWith("TITLE")) return { ...base, type: "title" };
  if (upper.startsWith("DATE")) return { ...base, type: "date" };
  if (upper.startsWith("PEOPLE") || upper.startsWith("PERSON")) return { ...base, type: "person" };
  if (upper.startsWith("CHECKBOX")) return { ...base, type: "checkbox" };
  if (upper.startsWith("URL")) return { ...base, type: "url" };
  if (upper.startsWith("EMAIL")) return { ...base, type: "email" };
  if (upper.startsWith("PHONE_NUMBER") || upper.startsWith("PHONE")) return { ...base, type: "phone" };
  if (upper.startsWith("STATUS")) return { ...base, type: "status", options: parseOptionNames(spec) };
  if (upper.startsWith("FILES") || upper.startsWith("FILE")) return { ...base, type: "files" };
  if (upper.startsWith("SELECT")) return { ...base, type: "select", options: parseOptionNames(spec) };
  if (upper.startsWith("MULTI_SELECT")) return { ...base, type: "multi_select", options: parseOptionNames(spec) };
  if (upper.startsWith("NUMBER")) {
    const numberFormat = spec.match(/\bFORMAT\s+'([^']+)'/i)?.[1] ?? spec.match(/\bFORMAT\s+"([^"]+)"/i)?.[1];
    return { ...base, type: "number", numberFormat: numberFormat ?? "number" };
  }
  if (upper.startsWith("FORMULA")) return { ...base, type: "formula", formula: firstQuoted(spec) };
  if (upper.startsWith("RELATION")) return { ...base, type: "relation", relationDatabaseId: stripHanjiId(firstQuoted(spec)) };
  if (upper.startsWith("ROLLUP")) {
    const args = parseQuotedList(spec.match(/\((.*)\)/s)?.[1] ?? "");
    return {
      ...base,
      type: "rollup",
      rollupRelationPropertyId: args[0],
      rollupTargetPropertyId: args[1],
      rollupFunction: args[2] ?? "show_original",
    };
  }
  if (upper.startsWith("UNIQUE_ID")) {
    const idPrefix = spec.match(/\bPREFIX\s+'([^']*)'/i)?.[1] ?? spec.match(/\bPREFIX\s+"([^"]*)"/i)?.[1] ?? "";
    return { ...base, type: "unique_id", idPrefix };
  }
  if (upper.startsWith("CREATED_TIME")) return { ...base, type: "created_time" };
  if (upper.startsWith("LAST_EDITED_TIME")) return { ...base, type: "last_edited_time" };
  if (upper.startsWith("CREATED_BY")) return { ...base, type: "created_by" };
  if (upper.startsWith("LAST_EDITED_BY")) return { ...base, type: "last_edited_by" };
  if (upper.startsWith("PLACE")) return { ...base, type: "rich_text", description: description ?? "Imported Notion PLACE property stored as text in Hanji." };
  return { ...base, type: "rich_text", description: description ?? `Unsupported Notion SQL type stored as text: ${spec}` };
}

function parseNotionCreateTableSchema(schema) {
  const body = String(schema ?? "").match(/CREATE\s+TABLE(?:\s+[^(]+)?\s*\((.*)\)\s*$/is)?.[1];
  if (!body) throw new Error("schema must be a CREATE TABLE (...) statement.");
  return splitTopLevel(body).map((column) => {
    const match = column.match(/^\s*"([^"]+)"\s+(.+)$/s) ?? column.match(/^\s*'([^']+)'\s+(.+)$/s);
    if (!match) throw new Error(`Could not parse schema column: ${column}`);
    return parseNotionSqlColumnType(match[2], match[1]);
  });
}

function parseNotionDdlStatements(statements) {
  return splitTopLevel(String(statements ?? ""), ";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => {
      let match = statement.match(/^ADD\s+COLUMN\s+"([^"]+)"\s+(.+)$/is);
      if (match) return { action: "add", property: parseNotionSqlColumnType(match[2], match[1]), raw: statement };
      match = statement.match(/^DROP\s+COLUMN\s+"([^"]+)"$/is);
      if (match) return { action: "drop", name: match[1], raw: statement };
      match = statement.match(/^RENAME\s+COLUMN\s+"([^"]+)"\s+TO\s+"([^"]+)"$/is);
      if (match) return { action: "rename", from: match[1], to: match[2], raw: statement };
      match = statement.match(/^ALTER\s+COLUMN\s+"([^"]+)"\s+SET\s+(.+)$/is);
      if (match) return { action: "alter", name: match[1], property: parseNotionSqlColumnType(match[2], match[1]), raw: statement };
      throw new Error(`Unsupported data source DDL statement: ${statement}`);
    });
}

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

function sqlLiteralValue(value) {
  if (value === "__YES__") return true;
  if (value === "__NO__") return false;
  if (value == null) return "";
  return value;
}

function compareSqlValues(left, operator, right) {
  const a = sqlLiteralValue(left);
  const b = sqlLiteralValue(right);
  if (operator === "=") return String(a) === String(b);
  if (operator === "!=" || operator === "<>") return String(a) !== String(b);
  if (operator.toUpperCase() === "LIKE") {
    const pattern = String(b).replace(/%/g, "").toLowerCase();
    return String(a).toLowerCase().includes(pattern);
  }
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    if (operator === ">=") return String(a) >= String(b);
    if (operator === "<=") return String(a) <= String(b);
    if (operator === ">") return String(a) > String(b);
    if (operator === "<") return String(a) < String(b);
    return false;
  }
  if (operator === ">=") return na >= nb;
  if (operator === "<=") return na <= nb;
  if (operator === ">") return na > nb;
  if (operator === "<") return na < nb;
  return false;
}

function sqlParamValue(raw, params = []) {
  const token = String(raw ?? "").trim();
  if (token === "?") return params.shift();
  const quoted = token.match(/^"([^"]*)"$/)?.[1] ?? token.match(/^'([^']*)'$/)?.[1];
  if (quoted !== undefined) return quoted;
  if (/^__YES__$/i.test(token)) return "__YES__";
  if (/^__NO__$/i.test(token)) return "__NO__";
  const number = Number(token);
  return Number.isFinite(number) ? number : token;
}

function applySimpleSqlWhere(rows, whereClause, params = []) {
  if (!whereClause) return rows;
  const terms = splitTopLevel(whereClause.replace(/\s+AND\s+/gi, ","), ",");
  return rows.filter((row) => {
    for (const term of terms) {
      const match = term.match(/^\s*"([^"]+)"\s*(=|!=|<>|>=|<=|>|<|LIKE)\s*(\?|".*?"|'.*?'|[^\s]+)\s*$/i);
      if (!match) throw new Error(`Unsupported SQL WHERE term: ${term}`);
      if (!compareSqlValues(row[match[1]], match[2], sqlParamValue(match[3], params))) return false;
    }
    return true;
  });
}

export function parseDataSourceSqlQuery(query) {
  const sql = String(query ?? "").trim().replace(/;$/, "");
  const match = sql.match(
    /^SELECT\s+(.+?)\s+FROM\s+"(collection:\/\/[0-9a-f-]{32,36})"(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+"([^"]+)"(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?(?:\s+OFFSET\s+(\d+))?$/is
  );
  if (!match) throw new Error('Only SELECT ... FROM "collection://..." queries with optional WHERE/ORDER BY/LIMIT/OFFSET are supported.');
  return {
    select: match[1].trim(),
    dataSourceUrl: match[2],
    where: match[3]?.trim(),
    orderBy: match[4],
    orderDirection: String(match[5] ?? "asc").toLowerCase() === "desc" ? "desc" : "asc",
    limit: match[6] ? Number(match[6]) : undefined,
    offset: match[7] ? Number(match[7]) : 0,
  };
}

function selectSqlColumns(rows, select) {
  const trimmed = String(select ?? "*").trim();
  if (trimmed === "*") return rows;
  if (/^COUNT\s*\(\s*\*\s*\)$/i.test(trimmed)) return [{ count: rows.length }];
  const columns = parseQuotedList(trimmed);
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
}

export async function queryDataSourceSql(data) {
  const requiredWorkspace = await requireWorkspaceSelection(data, "_notion_query_data_sources");
  if (requiredWorkspace.errorResult) return { __workspaceErrorResult: requiredWorkspace.errorResult };
  const parsed = parseDataSourceSqlQuery(data.query);
  const databaseId = stripHanjiId(parsed.dataSourceUrl);
  const [db, props, rows, pages] = await Promise.all([
    eb.getOne("pages", databaseId),
    eb.dbProperties(databaseId),
    eb.dbRows(databaseId, { includeComputed: true }),
    eb.pages(),
  ]);
  if (!db || db.kind !== "database") throw new Error(`Data source ${parsed.dataSourceUrl} not found.`);
  const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, db, "_notion_query_data_sources", "Data source");
  if (matched.errorResult) return { __workspaceErrorResult: matched.errorResult };
  const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const propsByDb = await databasePropsContext(pages, databaseId, props);
  let records = rows.map((row) => dataSourceRowObject(row, props, pagesById, propsByDb));
  records = applySimpleSqlWhere(records, parsed.where, [...(data.params ?? [])]);
  if (parsed.orderBy) {
    // Typed comparison via compareViewSortKeys (numbers numerically, strings
    // with numeric collation) so numeric columns do not sort "10" < "9".
    const direction = parsed.orderDirection === "desc" ? -1 : 1;
    records.sort(
      (a, b) => direction * compareViewSortKeys(a[parsed.orderBy] ?? "", b[parsed.orderBy] ?? "")
    );
  }
  const limit = parsed.limit ? clamp(parsed.limit, 1, 500) : 100;
  const offset = Math.max(0, Math.trunc(parsed.offset ?? 0));
  const windowed = records.slice(offset, offset + limit);
  const selected = selectSqlColumns(windowed, parsed.select);
  const nextOffset = offset + windowed.length;
  return {
    mode: "sql",
    data_source_url: parsed.dataSourceUrl,
    results: selected,
    rows: selected,
    returned: selected.length,
    has_more: nextOffset < records.length,
    // Cursor = the OFFSET of the next window; re-issue the query with
    // "... LIMIT <n> OFFSET <next_cursor>" to page.
    next_cursor: nextOffset < records.length ? String(nextOffset) : null,
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
    eb.dbRows(db.id, { includeComputed: true }),
    eb.pages(),
  ]);
  const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
  const propsByDb = await databasePropsContext(pages, db.id, props);
  const filtered = applyDatabaseView(rows, props, pagesById, view, undefined, propsByDb);
  const start = Math.max(0, Number.parseInt(data.start_cursor ?? "0", 10) || 0);
  const pageSize = clamp(data.page_size ?? 100, 1, 100);
  const selected = filtered.slice(start, start + pageSize).map((row) => dataSourceRowObject(row, props, pagesById, propsByDb));
  return {
    mode: "view",
    view_id: view.id,
    data_source_url: collectionUrl(db.id),
    results: selected,
    rows: selected,
    has_more: start + selected.length < filtered.length,
    next_cursor: start + selected.length < filtered.length ? String(start + selected.length) : null,
  };
}

function parseNotionViewConfigDsl(configure) {
  const config = {};
  const directives = String(configure ?? "")
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const directive of directives) {
    let match = directive.match(/^CLEAR\s+FILTERS?$/i);
    if (match) {
      config.filterGroup = null;
      config.filters = [];
      continue;
    }
    match = directive.match(/^CLEAR\s+SORTS?$/i);
    if (match) {
      config.sorts = [];
      continue;
    }
    match = directive.match(/^CLEAR\s+GROUP\s+BY$/i);
    if (match) {
      config.groupBy = "";
      config.subGroupBy = "";
      continue;
    }
    match = directive.match(/^SORT\s+BY\s+(.+?)(?:\s+(ASC|DESC))?$/i);
    if (match) {
      const properties = parseQuotedList(match[1]);
      config.sorts = properties.map((property) => ({
        property,
        direction: String(match[2] ?? "asc").toLowerCase() === "desc" ? "desc" : "asc",
      }));
      continue;
    }
    match = directive.match(/^FILTER\s+"([^"]+)"\s*(=|!=|CONTAINS)\s*(?:"([^"]*)"|'([^']*)'|(.+))$/i);
    if (match) {
      const operator = match[2] === "!=" ? "does_not_equal" : match[2].toUpperCase() === "CONTAINS" ? "contains" : "equals";
      const value = match[3] ?? match[4] ?? String(match[5] ?? "").trim();
      config.filters = [...(config.filters ?? []), { property: match[1], operator, value }];
      continue;
    }
    match = directive.match(/^FILTER\s+"([^"]+)"\s+IS\s+(NOT\s+)?EMPTY$/i);
    if (match) {
      config.filters = [...(config.filters ?? []), { property: match[1], operator: match[2] ? "is_not_empty" : "is_empty" }];
      continue;
    }
    match = directive.match(/^GROUP\s+BY\s+(.+)$/i);
    if (match) {
      config.groupBy = parseQuotedList(match[1])[0] ?? "";
      continue;
    }
    match = directive.match(/^CALENDAR\s+BY\s+(.+)$/i);
    if (match) {
      config.calendarBy = parseQuotedList(match[1])[0] ?? "";
      continue;
    }
    match = directive.match(/^TIMELINE\s+BY\s+(.+)$/i);
    if (match) {
      const parts = String(match[1]).split(/\s+TO\s+/i);
      config.timelineBy = parseQuotedList(parts[0])[0] ?? "";
      if (parts[1]) config.timelineEndBy = parseQuotedList(parts[1])[0] ?? "";
      continue;
    }
    match = directive.match(/^TIMELINE\s+END\s+BY\s+(.+)$/i);
    if (match) {
      config.timelineEndBy = parseQuotedList(match[1])[0] ?? "";
      continue;
    }
    match = directive.match(/^SHOW\s+(.+)$/i);
    if (match) {
      config.visibleProperties = parseQuotedList(match[1]);
      continue;
    }
    match = directive.match(/^HIDE\s+(.+)$/i);
    if (match) {
      config.hiddenProperties = parseQuotedList(match[1]);
      continue;
    }
    match = directive.match(/^COVER\s+(.+)$/i);
    if (match) {
      config.coverProperty = parseQuotedList(match[1])[0] ?? "";
      continue;
    }
    if (/^WRAP\s+CELLS?$/i.test(directive) || /^WRAP$/i.test(directive)) {
      config.wrap = true;
      continue;
    }
    if (/^(NO\s+WRAP|UNWRAP)(\s+CELLS?)?$/i.test(directive)) {
      config.wrap = false;
      continue;
    }
    throw new Error(`Unsupported Hanji view configure directive: ${directive}`);
  }
  return config;
}

function normalizeNotionViewConfigureInput(configure) {
  if (typeof configure === "string") return parseNotionViewConfigDsl(configure);
  return normalizeNotionViewConfig(configure);
}

function viewConfigPatchForNotionInput(props, type, input = {}, base = {}) {
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
  return viewConfigPatchForInput(props, type, normalized, base);
}

server.registerTool(
  "create_database_view",
  {
    title: "Create database view",
    description:
      "Create a saved database view and configure visible properties, filters, grouping, date axes, card display, row opening, and sorts.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      type: z.enum(DATABASE_VIEW_TYPES).describe("View type"),
      name: z.string().optional().describe("View name; defaults to the type label"),
      ...viewConfigInputSchema,
    },
  },
  async ({ databaseId, type, name, ...configInput }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const [props, views] = await Promise.all([eb.dbProperties(databaseId), eb.dbViews(databaseId)]);
      const duplicate = views.find((view) => view.name.trim().toLowerCase() === (name ?? databaseViewLabel(type)).trim().toLowerCase());
      if (duplicate) return ok(`View "${duplicate.name}" already exists (id: ${duplicate.id}).`);
      const { config, changed } = viewConfigPatchForInput(props, type, configInput);
      const view = await eb.insert("db_views", {
        id: eb.newId(),
        databaseId,
        name: name?.trim() || databaseViewLabel(type),
        type,
        config,
        position: views.reduce((max, item) => Math.max(max, item.position ?? 0), 0) + 1,
      });
      return ok(
        `Created view "${view.name}" [${view.type}] in ${titleOf(db)}.\n` +
          `${viewLine(view, props)}` +
          `${changed.length ? `\nconfigured: ${changed.join(", ")}` : ""}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "_notion_create_view",
  {
    title: "Create view",
    description:
      "Notion-compatible database view creation. Hanji MCP is account-scoped, so workspace_id is required. Hanji supports table, board, list, calendar, timeline, and gallery views.",
    inputSchema: {
      workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
      teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
      database_id: z.string().optional(),
      parent_page_id: z.string().optional(),
      data_source_id: z.string(),
      name: z.string(),
      type: z.enum(NOTION_VIEW_TYPES),
      configure: z.string().optional(),
    },
  },
  async ({ workspace_id, teamspace_id, database_id, parent_page_id, data_source_id, name, type, configure }) => {
    try {
      const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_create_view");
      if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
      if (UNSUPPORTED_NOTION_VIEW_TYPES.includes(type)) {
        return okJson({
          is_unsupported: true,
          unsupported_feature: `view_type:${type}`,
          message: `Hanji does not provide a ${type} view type yet. Supported view types: ${DATABASE_VIEW_TYPES.join(", ")}.`,
        });
      }
      const databaseId = stripHanjiId(data_source_id || database_id);
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Data source ${data_source_id} not found.`);
      const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, db, "_notion_create_view", "Data source");
      if (matched.errorResult) return matched.errorResult;
      if (db.isLocked) return ok(lockedPageMessage(db));
      if ((database_id ? 1 : 0) + (parent_page_id ? 1 : 0) !== 1) {
        throw new Error("Provide exactly one of database_id or parent_page_id.");
      }
      // Validate the destination parent BEFORE inserting the view so a bad
      // parent_page_id cannot leave an orphaned view behind.
      let parent = null;
      if (parent_page_id) {
        const parentPageId = stripHanjiId(parent_page_id);
        parent = await eb.getOne("pages", parentPageId);
        if (!parent || parent.kind !== "page") throw new Error(`Parent page ${parent_page_id} not found.`);
        const parentMatched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, parent, "_notion_create_view", "Parent page");
        if (parentMatched.errorResult) return parentMatched.errorResult;
      }

      const [props, views] = await Promise.all([eb.dbProperties(databaseId), eb.dbViews(databaseId)]);
      const duplicate = views.find((view) => view.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (duplicate) return ok(`View "${duplicate.name}" already exists (id: ${duplicate.id}).`);
      const { config } = viewConfigPatchForNotionInput(props, type, normalizeNotionViewConfigureInput(configure));
      const view = await eb.insert("db_views", {
        id: eb.newId(),
        databaseId,
        name: name.trim() || databaseViewLabel(type),
        type,
        config,
        position: views.reduce((max, item) => Math.max(max, item.position ?? 0), 0) + 1,
      });

      let blockId = null;
      if (parent) {
        try {
          const rootBlocks = (await eb.blocks(parent.id)).filter((block) => !block.parentId);
          const position = positionBetween(rootBlocks.reduce((max, block) => Math.max(max, block.position ?? 0), 0), undefined);
          const block = await eb.insert("blocks", {
            id: eb.newId(),
            pageId: parent.id,
            parentId: null,
            type: "inline_database",
            content: {
              childPageId: databaseId,
              childPageTitle: db.title || "Untitled",
              childPageKind: "database",
              databaseViewId: view.id,
              rich: [{ text: db.title || "Untitled" }],
            },
            plainText: db.title || "Untitled",
            position,
            createdBy: MCP_ACTOR,
          });
          blockId = block.id;
        } catch (error) {
          // Roll back the freshly created view (insertTemplateBlocks pattern)
          // so a failed embed does not orphan it.
          await eb.del("db_views", view.id, { databaseId }).catch(() => {});
          throw error;
        }
      }

      return okJson({
        id: view.id,
        name: view.name,
        type: view.type,
        data_source_url: collectionUrl(databaseId),
        block_id: blockId,
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "update_database_view",
  {
    title: "Update database view",
    description:
      "Update a saved database view's name, type, visible properties, filters, grouping, date axes, card display, row opening, and sorts.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      view: z.string().describe("View name or id"),
      name: z.string().optional().describe("New view name"),
      type: z.enum(DATABASE_VIEW_TYPES).optional().describe("New view type"),
      ...viewConfigInputSchema,
    },
  },
  async ({ databaseId, view: viewKey, name, type, ...configInput }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const [props, views] = await Promise.all([eb.dbProperties(databaseId), eb.dbViews(databaseId)]);
      const view = viewByKey(views, viewKey);
      if (!view) return ok(`View "${viewKey}" not found in ${titleOf(db)}.`);

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

      const nextType = type ?? view.type;
      const { config, changed: configChanged } = viewConfigPatchForInput(props, nextType, configInput, view.config);
      if (configChanged.length || type !== undefined) {
        patch.config = config;
        changed.push(...configChanged);
      }

      if (Object.keys(patch).length === 0) return ok(`No changes supplied for view "${view.name}".`);
      const updated = await eb.update("db_views", view.id, patch, { databaseId });
      return ok(
        `Updated view "${updated.name}" in ${titleOf(db)}.\n` +
          `${viewLine(updated, props)}\n` +
          `changed: ${Array.from(new Set(changed)).join(", ")}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

const NOTION_UPDATE_VIEW_TOOL = {
  title: "Update view",
  description:
    "Notion-compatible view update. Hanji MCP is account-scoped, so workspace_id is required. Accepts view_id plus optional name and configure DSL. Object configure and direct view fields are also accepted.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    view_id: z.string().describe("View id, view:// URI, Notion URL with ?v=, or local view name"),
    database_id: z.string().optional().describe("Optional database page id to avoid scanning all data sources"),
    data_source_id: z.string().optional().describe("Optional collection/data source id"),
    data_source_url: z.string().optional().describe("Optional collection://<database-id> data source URL"),
    name: z.string().optional().describe("New view name"),
    type: z.enum(DATABASE_VIEW_TYPES).optional().describe("New view type"),
    configure: z.union([z.string(), JsonObjectSchema]).optional().describe("Notion-style view configuration DSL string, or a config object"),
    ...viewConfigInputSchema,
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

registerToolAliases(["update_view", "_notion_update_view"], NOTION_UPDATE_VIEW_TOOL, handleNotionUpdateView);

server.registerTool(
  "delete_database_view",
  {
    title: "Delete database view",
    description: "Delete a saved database view. The final remaining view is protected.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      view: z.string().describe("View name or id"),
    },
  },
  async ({ databaseId, view: viewKey }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const views = await eb.dbViews(databaseId);
      const view = viewByKey(views, viewKey);
      if (!view) return ok(`View "${viewKey}" not found in ${titleOf(db)}.`);
      if (views.length <= 1) return ok(`Cannot delete the only view in ${titleOf(db)}.`);
      await eb.del("db_views", view.id, { databaseId });
      return ok(`Deleted view "${view.name}" from ${titleOf(db)}.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_database_templates",
  {
    title: "List database templates",
    description: "List page templates configured for a database.",
    inputSchema: { databaseId: z.string().describe("Database page id") },
  },
  async ({ databaseId }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      const templates = await eb.dbTemplates(databaseId);
      if (templates.length === 0) return ok(`No templates found in ${titleOf(db)}.`);
      return ok(
        templates
          .map((template) => {
            const blockCount = countTemplateBlocks(template.blocks);
            const title = template.title ? ` title: ${template.title}` : "";
            return `- ${template.icon ?? ""} ${template.name || "Untitled template"}${
              template.isDefault ? " [default]" : ""
            }${
              title ? ` (${title.trim()})` : ""
            }  id: ${template.id}  blocks: ${blockCount}`;
          })
          .join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "create_database_template",
  {
    title: "Create database template",
    description:
      "Create a database row/page template. Properties can be keyed by property name or id, and content is Markdown.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      name: z.string().describe("Template name"),
      title: z.string().optional().describe("Default row title / Name property"),
      icon: z.string().optional().describe("Optional emoji icon"),
      isDefault: z.boolean().optional().describe("Use this template when creating rows without a template id"),
      properties: JsonObjectSchema.optional().describe("Default property values keyed by property name or id"),
      content: z.string().optional().describe("Default page body as Markdown"),
    },
  },
  async ({ databaseId, name, title, icon, isDefault, properties, content }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const [props, templates] = await Promise.all([eb.dbProperties(databaseId), eb.dbTemplates(databaseId)]);
      const { patch, unknown, readonly } = rowPatchFromProperties(props, properties ?? {});
      const blocks = content ? markdownToBlocks(content) : [{ type: "paragraph", content: { rich: [] } }];
      const template = await eb.insert("db_templates", {
        id: eb.newId(),
        databaseId,
        name,
        icon,
        title: title ?? patch.title ?? "",
        properties: patch.properties,
        blocks,
        isDefault: !!isDefault,
        position: templates.reduce((max, item) => Math.max(max, item.position ?? 0), 0) + 1,
      });
      if (isDefault) {
        await Promise.all(
          templates
            .filter((item) => item.isDefault)
            .map((item) =>
              eb.update("db_templates", item.id, { isDefault: false }, { databaseId: item.databaseId ?? databaseId })
            )
        );
      }
      const notes = [
        template.isDefault ? "Set as default template" : "",
        unknown.length ? `Ignored unknown properties: ${unknown.join(", ")}` : "",
        readonly.length ? `Skipped read-only properties: ${readonly.join(", ")}` : "",
      ].filter(Boolean);
      return ok(
        `Created template "${template.name || "Untitled template"}" in ${titleOf(db)}.\n` +
          `template id: ${template.id}` +
          `${notes.length ? `\n${notes.join("\n")}` : ""}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "get_database_template",
  {
    title: "Get database template",
    description: "Read a database template's metadata, default properties, and Markdown body.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      templateId: z.string().describe("Database template id"),
    },
  },
  async ({ databaseId, templateId }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      const [props, templates, pages] = await Promise.all([
        eb.dbProperties(databaseId),
        eb.dbTemplates(databaseId),
        eb.pages(),
      ]);
      const template = templates.find((item) => item.id === templateId);
      if (!template) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);
      const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
      const propLines = props
        .filter((prop) => prop.type !== "title" && template.properties?.[prop.id] != null)
        .map((prop) => `- ${prop.name}: ${formatDbValue({ properties: template.properties }, prop, pagesById, props)}`);
      const body = templateBlocksToMarkdown(template.blocks);
      return ok(
        `# ${template.icon ?? ""} ${template.name || "Untitled template"}\n` +
          `template id: ${template.id}\n` +
          `database: ${titleOf(db)} (${db.id})\n` +
          `default: ${template.isDefault ? "yes" : "no"}\n` +
          `default title: ${template.title || ""}\n\n` +
          `## Properties\n${propLines.length ? propLines.join("\n") : "_No default properties_"}\n\n` +
          `## Content\n${body || "_(empty template)_"}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "update_database_template",
  {
    title: "Update database template",
    description:
      "Update a database template's metadata, default properties, or Markdown body. Omitted fields are left unchanged.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      templateId: z.string().describe("Database template id"),
      name: z.string().optional().describe("Template name"),
      title: z.string().optional().describe("Default row title / Name property"),
      icon: z.string().optional().describe("Emoji icon. Pass an empty string to clear."),
      isDefault: z.boolean().optional().describe("Whether this is the default template for new rows"),
      properties: JsonObjectSchema.optional().describe("Properties to merge into template defaults"),
      replaceProperties: z.boolean().optional().describe("Replace all editable defaults instead of merging"),
      content: z.string().optional().describe("Replace the template body with Markdown"),
    },
  },
  async ({ databaseId, templateId, name, title, icon, isDefault, properties, replaceProperties, content }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const [props, templates] = await Promise.all([eb.dbProperties(databaseId), eb.dbTemplates(databaseId)]);
      const template = templates.find((item) => item.id === templateId);
      if (!template) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);

      const update = {};
      if (name !== undefined) update.name = name;
      if (title !== undefined) update.title = title;
      if (icon !== undefined) update.icon = icon || null;
      if (isDefault !== undefined) update.isDefault = isDefault;
      if (content !== undefined) update.blocks = markdownToBlocks(content);

      const notes = [];
      if (properties !== undefined) {
        const { patch, unknown, readonly } = rowPatchFromProperties(props, properties);
        update.properties = replaceProperties
          ? patch.properties
          : { ...(template.properties ?? {}), ...(patch.properties ?? {}) };
        if (patch.title !== undefined && title === undefined) update.title = patch.title;
        if (unknown.length) notes.push(`Ignored unknown properties: ${unknown.join(", ")}`);
        if (readonly.length) notes.push(`Skipped read-only properties: ${readonly.join(", ")}`);
      }

      if (Object.keys(update).length === 0) return ok(`No changes supplied for template ${templateId}.`);
      const updated = await eb.update("db_templates", template.id, update, { databaseId });
      if (isDefault) await clearOtherDefaultTemplates(databaseId, template.id);
      return ok(
        `Updated template "${updated.name || "Untitled template"}" in ${titleOf(db)}.\n` +
          `template id: ${template.id}${notes.length ? `\n${notes.join("\n")}` : ""}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "duplicate_database_template",
  {
    title: "Duplicate database template",
    description: "Duplicate an existing database template, including default properties and Markdown body.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      templateId: z.string().describe("Template id to duplicate"),
      name: z.string().optional().describe("Optional name for the duplicated template"),
      isDefault: z.boolean().optional().describe("Make the duplicate the default template"),
    },
  },
  async ({ databaseId, templateId, name, isDefault }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const templates = await eb.dbTemplates(databaseId);
      const source = templates.find((item) => item.id === templateId);
      if (!source) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);
      const duplicate = await eb.insert("db_templates", {
        id: eb.newId(),
        databaseId,
        name: name ?? `${source.name || "Untitled template"} copy`,
        icon: source.icon,
        title: source.title ?? "",
        properties: cloneJson(source.properties ?? {}),
        blocks: cloneJson(source.blocks ?? [{ type: "paragraph", content: { rich: [] } }]),
        isDefault: !!isDefault,
        position: templates.reduce((max, item) => Math.max(max, item.position ?? 0), 0) + 1,
      });
      if (isDefault) await clearOtherDefaultTemplates(databaseId, duplicate.id);
      return ok(
        `Duplicated template "${source.name || "Untitled template"}" as "${
          duplicate.name || "Untitled template"
        }" in ${titleOf(db)}.\n` +
          `template id: ${duplicate.id}` +
          `${duplicate.isDefault ? "\nSet as default template" : ""}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "delete_database_template",
  {
    title: "Delete database template",
    description: "Delete a database template. Existing rows created from it are not changed.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      templateId: z.string().describe("Database template id"),
    },
  },
  async ({ databaseId, templateId }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const template = (await eb.dbTemplates(databaseId)).find((item) => item.id === templateId);
      if (!template) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);
      await eb.del("db_templates", template.id, { databaseId });
      return ok(`Deleted template "${template.name || "Untitled template"}" from ${titleOf(db)}.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "query_database",
  {
    title: "Query database",
    description:
      "Read database rows as a Markdown table. Optionally apply a saved view's visible properties, filters, and sorts.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      view: z.string().optional().describe("Optional saved view name or id to apply"),
      limit: z.number().int().min(1).max(100).optional().describe("Rows to return, default 25"),
      search: z.string().optional().describe("Optional case-insensitive search over row title and displayed properties"),
    },
    outputSchema: MCP_QUERY_DATABASE_OUTPUT_SCHEMA,
  },
  async ({ databaseId, view: viewKey, limit = 25, search }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      const safeLimit = clamp(limit, 1, 100);
      if (!db || db.kind !== "database") {
        const message = `Database ${databaseId} not found.`;
        return okStructured(
          message,
          queryDatabaseStructuredContent({ database: null, limit: safeLimit, search, message })
        );
      }
      const [props, rows, pages, views] = await Promise.all([
        eb.dbProperties(databaseId),
        eb.dbRows(databaseId, { includeComputed: true }),
        eb.pages(),
        eb.dbViews(databaseId),
      ]);
      const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
      const propsByDb = await databasePropsContext(pages, databaseId, props);
      const selectedView = viewKey ? viewByKey(views, viewKey) : undefined;
      if (viewKey && !selectedView) {
        const message = `View "${viewKey}" not found in ${titleOf(db)}.`;
        return okStructured(
          message,
          queryDatabaseStructuredContent({ database: db, limit: safeLimit, search, message })
        );
      }
      const visibleProps = props.length
        ? viewDisplayProperties(props, selectedView)
        : [{ id: "__title", name: "Name", type: "title" }];
      const filtered = applyDatabaseView(rows, props, pagesById, selectedView, search, propsByDb);
      const selected = filtered.slice(0, safeLimit);
      if (selected.length === 0) {
        const message = `No rows found in ${titleOf(db)}.`;
        return okStructured(
          message,
          queryDatabaseStructuredContent({
            database: db,
            view: selectedView,
            visibleProps,
            rows: selected,
            totalMatching: filtered.length,
            limit: safeLimit,
            search,
            pagesById,
            props,
            propsByDb,
            message,
          })
        );
      }
      const headers = ["row id", ...visibleProps.map((prop) => prop.name)];
      const lines = [
        `# ${titleOf(db)}`,
        ...(selectedView ? [`view: ${selectedView.name} [${selectedView.type}]`] : []),
        `Showing ${selected.length} of ${filtered.length} matching row(s).`,
        "",
        `| ${headers.map(md).join(" | ")} |`,
        `| ${headers.map(() => "---").join(" | ")} |`,
        ...selected.map((row) =>
          `| ${[row.id, ...visibleProps.map((prop) => formatDbValue(row, prop, pagesById, props, propsByDb))]
            .map(md)
            .join(" | ")} |`
        ),
      ];
      return okStructured(
        lines.join("\n"),
        queryDatabaseStructuredContent({
          database: db,
          view: selectedView,
          visibleProps,
          rows: selected,
          totalMatching: filtered.length,
          limit: safeLimit,
          search,
          pagesById,
          props,
          propsByDb,
        })
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "_notion_query_data_sources",
  {
    title: "Query data sources",
    description:
      "Notion-compatible data source query. Hanji MCP is account-scoped, so data.workspace_id is required. Supports read-only SELECT SQL over collection:// tables and view-mode queries over Hanji database views.",
    inputSchema: {
      data: JsonObjectSchema.describe("SQL mode: {workspace_id, data_source_urls, query, params}; view mode: {workspace_id, mode:'view', view_url, page_size, start_cursor}. teamspace_id is accepted as an alias."),
    },
  },
  async ({ data }) => {
    try {
      const input = data && typeof data === "object" && !Array.isArray(data) ? data : {};
      const result = input.mode === "view" ? await queryDataSourceView(input) : await queryDataSourceSql(input);
      if (result?.__workspaceErrorResult) return result.__workspaceErrorResult;
      return okJson(result);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "add_database_row",
  {
    title: "Add database row",
    description:
      "Create a row in a database. Properties can be keyed by property name or id. Select/status values may use option names.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      title: z.string().optional().describe("Row title / Name property"),
      templateId: z.string().optional().describe("Optional database template id to apply"),
      empty: z.boolean().optional().describe("Skip the database default template"),
      properties: JsonObjectSchema.optional().describe("Property values keyed by property name or id"),
    },
  },
  async ({ databaseId, title, templateId, empty, properties }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const [props, templates] = await Promise.all([
        eb.dbProperties(databaseId),
        eb.dbTemplates(databaseId),
      ]);
      const template = templateId
        ? templates.find((item) => item.id === templateId)
        : empty
          ? undefined
          : templates.find((item) => item.isDefault);
      if (templateId && !template) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);
      const { patch, unknown, readonly } = rowPatchFromProperties(props, properties ?? {});
      const result = await eb.createDatabaseRow({
        id: eb.newId(),
        databaseId,
        templateId: templateId ?? undefined,
        empty: !!empty,
        title: patch.title ?? title,
        properties: patch.properties ?? {},
      });
      const row = result.row;
      const blockCount = result.blocks?.length ?? 0;
      const notes = [
        template ? `Applied template: ${template.name || template.id}` : "",
        blockCount ? `Added ${blockCount} template block(s)` : "",
        unknown.length ? `Ignored unknown properties: ${unknown.join(", ")}` : "",
        readonly.length ? `Skipped read-only properties: ${readonly.join(", ")}` : "",
      ].filter(Boolean);
      return ok(
        `Created row "${row.title || "Untitled"}" in ${titleOf(db)}.\nrow id: ${row.id}${
          notes.length ? `\n${notes.join("\n")}` : ""
        }`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "update_database_row",
  {
    title: "Update database row",
    description:
      "Update a database row by row id. Properties can be keyed by property name or id. Only supplied properties are changed.",
    inputSchema: {
      rowId: z.string().describe("Database row page id"),
      title: z.string().optional().describe("New row title / Name property"),
      properties: JsonObjectSchema.optional().describe("Property values keyed by property name or id"),
    },
  },
  async ({ rowId, title, properties }) => {
    try {
      const row = await eb.getOne("pages", rowId);
      if (!row || row.parentType !== "database" || !row.parentId) {
        return ok(`Database row ${rowId} not found.`);
      }
      if (row.isLocked) return ok(lockedPageMessage(row));
      const db = await eb.getOne("pages", row.parentId);
      if (!db || db.kind !== "database") return ok(`Database ${row.parentId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const props = await eb.dbProperties(row.parentId);
      const { patch, unknown, readonly } = rowPatchFromProperties(props, properties ?? {});
      if (title !== undefined) patch.title = title;
      const nextProperties = persistableDatabaseRowProperties({
        ...(row.properties ?? {}),
        ...(patch.properties ?? {}),
      });
      const update = {};
      if (patch.title !== undefined) update.title = patch.title;
      if (Object.keys(patch.properties ?? {}).length > 0) update.properties = nextProperties;
      if (Object.keys(update).length === 0) {
        return ok(`No editable changes supplied for row ${rowId}.`);
      }
      const updated = await eb.updateDatabaseRow(rowId, { ...update, ...pageEditAudit() });
      const notes = [
        unknown.length ? `Ignored unknown properties: ${unknown.join(", ")}` : "",
        readonly.length ? `Skipped read-only properties: ${readonly.join(", ")}` : "",
      ].filter(Boolean);
      return ok(
        `Updated row "${updated.title || "Untitled"}" (id: ${rowId}).${
          notes.length ? `\n${notes.join("\n")}` : ""
        }`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "move_database_row",
  {
    title: "Move database row",
    description:
      "Move a database row before or after another row in the same database through the backend product API.",
    inputSchema: {
      rowId: z.string().describe("Database row page id to move"),
      targetRowId: z.string().describe("Sibling database row id to move before/after"),
      side: z.enum(["before", "after"]).optional().describe("Where to place the row relative to targetRowId"),
    },
  },
  async ({ rowId, targetRowId, side = "after" }) => {
    try {
      const result = await eb.moveDatabaseRow(rowId, targetRowId, side);
      const row = result.row ?? {};
      const target = result.target ?? {};
      return ok(
        `Moved row "${row.title || "Untitled"}" (id: ${row.id || rowId}) ${side} ` +
          `"${target.title || "Untitled"}" (id: ${target.id || targetRowId}).\n` +
          `position: ${result.position ?? row.position ?? ""}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "trash_database_row",
  {
    title: "Trash database row",
    description: "Move a database row to trash (soft delete).",
    inputSchema: { rowId: z.string().describe("Database row page id") },
  },
  async ({ rowId }) => {
    try {
      const row = await eb.getOne("pages", rowId);
      if (!row || row.parentType !== "database") return ok(`Database row ${rowId} not found.`);
      const db = row.parentId ? await eb.getOne("pages", row.parentId) : null;
      if (!db || db.kind !== "database") return ok(`Database ${row.parentId ?? ""} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const result = await trashPageTree(rowId);
      return ok(
        `Moved row "${row.title || "Untitled"}" (id: ${rowId}) to trash` +
          `${result?.count && result.count > 1 ? ` with ${result.count - 1} child page(s)` : ""}.`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "restore_database_row",
  {
    title: "Restore database row",
    description: "Restore a trashed database row and its row-page subtree.",
    inputSchema: { rowId: z.string().describe("Database row page id") },
  },
  async ({ rowId }) => {
    try {
      const row = await eb.getOne("pages", rowId);
      if (!row || row.parentType !== "database") return ok(`Database row ${rowId} not found.`);
      const db = row.parentId ? await eb.getOne("pages", row.parentId) : null;
      if (!db || db.kind !== "database") return ok(`Database ${row.parentId ?? ""} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const result = await restorePageTree(rowId);
      return ok(
        `Restored row "${row.title || "Untitled"}" (id: ${rowId})` +
          `${result?.count && result.count > 1 ? ` with ${result.count - 1} child page(s)` : ""}.`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "delete_database_row_forever",
  {
    title: "Delete database row forever",
    description:
      "Permanently delete a database row already in trash and clean its row-page subtree, including child pages, blocks, comments, collaboration logs, notifications, and files.",
    inputSchema: { rowId: z.string().describe("Database row page id") },
  },
  async ({ rowId }) => {
    try {
      const row = await eb.getOne("pages", rowId);
      if (!row || row.parentType !== "database") return ok(`Database row ${rowId} not found.`);
      if (!row.inTrash) {
        throw new Error(`Database row ${rowId} must be moved to trash before permanent deletion.`);
      }
      const db = row.parentId ? await eb.getOne("pages", row.parentId) : null;
      if (!db || db.kind !== "database") return ok(`Database ${row.parentId ?? ""} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const result = await eb.deleteDatabaseRow(rowId, {
        databaseId: row.parentId,
        workspaceId: row.workspaceId,
      });
      const cleanup = result.cleanup ?? {};
      return ok(
        `Deleted row "${row.title || "Untitled"}" (id: ${rowId}) forever.\n` +
          `deleted pages: ${result.deletedIds?.length ?? 1}\n` +
          `cleaned blocks: ${cleanup.blocks ?? 0}\n` +
          `cleaned comments: ${cleanup.comments ?? 0}\n` +
          `cleaned collaboration logs: ${cleanup.collaborationOperations ?? 0}\n` +
          `cleaned files: ${cleanup.fileUploads ?? 0}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "add_database_property",
  {
    title: "Add database property",
    description:
      "Add a property to a database schema. For select/status/multi-select, pass option names in options.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      name: z.string().describe("Property name"),
      type: z.enum(DATABASE_PROPERTY_TYPES).describe("Property type"),
      options: z.array(z.string()).optional().describe("Option names for select, status, or multi-select"),
      numberFormat: z.enum(["number", "comma", "percent", "dollar", "won", "euro"]).optional(),
      idPrefix: z.string().optional().describe("Display prefix for ID properties, e.g. TASK"),
      relationDatabaseId: z.string().optional().describe("Related database id for relation properties"),
      twoWay: z.boolean().optional().describe("For relation properties: create a Notion-style two-way relation. The backend creates and cross-links a reciprocal relation property on the related database. Defaults to one-way."),
      formula: z.string().optional().describe("Formula expression for formula properties"),
      rollupRelationPropertyId: z.string().optional(),
      rollupTargetPropertyId: z.string().optional(),
      rollupFunction: z.enum(ROLLUP_FUNCTIONS).optional(),
      hideWhenEmpty: z.boolean().optional().describe("Hide this property in row/page panels when its value is empty"),
      hideInPagePanel: z.boolean().optional().describe("Always hide this property in row/page panels until hidden properties are expanded"),
    },
  },
  async ({ databaseId, name, type, ...configInput }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const existing = await eb.dbProperties(databaseId);
      const duplicate = existing.find((prop) => prop.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (duplicate) return ok(`Property "${name}" already exists (id: ${duplicate.id}).`);
      const id = eb.newId();
      const position = existing.reduce((max, prop) => Math.max(max, prop.position ?? 0), 0) + 1;
      const config = propertyConfigForInput(type, configInput, databaseId);
      await eb.insert("db_properties", {
        id,
        databaseId,
        name,
        type,
        config,
        position,
      });
      const updatedViews = await addPropertyToViews(databaseId, id);
      return ok(
        `Added property "${name}" [${type}] to ${titleOf(db)}.\nproperty id: ${id}${
          updatedViews.length ? `\nAdded to views: ${updatedViews.join(", ")}` : ""
        }`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "update_database_property",
  {
    title: "Update database property",
    description:
      "Update a database property's name, description, options, formatting, relation/formula/rollup config, or row-page display settings.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      property: z.string().describe("Property name or id"),
      name: z.string().optional().describe("New property name"),
      description: z.string().optional().describe("Property description. Pass an empty string to clear."),
      options: z.array(z.string()).optional().describe("Replace option names for select, status, or multi-select. Existing options keep ids when names match."),
      numberFormat: z.enum(["number", "comma", "percent", "dollar", "won", "euro"]).optional(),
      idPrefix: z.string().optional().describe("Display prefix for ID properties, e.g. TASK. Pass an empty string to clear."),
      relationDatabaseId: z.string().optional().describe("Related database id for relation properties"),
      twoWay: z.boolean().optional().describe("For relation properties: enable a Notion-style two-way relation by creating a cross-linked reciprocal property on the related database. Only enabling is supported here; to remove a two-way relation, delete the paired property."),
      formula: z.string().optional().describe("Formula expression for formula properties"),
      rollupRelationPropertyId: z.string().optional(),
      rollupTargetPropertyId: z.string().optional(),
      rollupFunction: z.enum(ROLLUP_FUNCTIONS).optional(),
      hideWhenEmpty: z.boolean().optional().describe("Hide this property in row/page panels when its value is empty"),
      hideInPagePanel: z.boolean().optional().describe("Always hide this property in row/page panels until hidden properties are expanded"),
    },
  },
  async ({ databaseId, property, name, description, ...configInput }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const props = await eb.dbProperties(databaseId);
      const prop = propertyByKey(props, property);
      if (!prop) return ok(`Property "${property}" not found in ${titleOf(db)}.`);

      const patch = {};
      const changedFields = [];
      if (name !== undefined) {
        const trimmed = name.trim();
        if (!trimmed) return ok("Property name cannot be empty.");
        const duplicate = props.find(
          (item) => item.id !== prop.id && item.name.trim().toLowerCase() === trimmed.toLowerCase()
        );
        if (duplicate) return ok(`Property "${trimmed}" already exists (id: ${duplicate.id}).`);
        patch.name = trimmed;
        changedFields.push("name");
      }
      if (description !== undefined) {
        patch.description = description || null;
        changedFields.push("description");
      }

      const { config, changed } = propertyConfigPatchForInput(prop, configInput);
      if (changed.length) {
        patch.config = config;
        changedFields.push(...changed);
      }

      if (Object.keys(patch).length === 0) return ok(`No changes supplied for property "${prop.name}".`);
      const updated = await eb.update("db_properties", prop.id, patch, { databaseId });
      return ok(
        `Updated property "${updated.name}" in ${titleOf(db)}.\n` +
          `${schemaLine(updated)}\n` +
          `changed: ${Array.from(new Set(changedFields)).join(", ")}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "delete_database_property",
  {
    title: "Delete database property",
    description:
      "Delete a non-title database property and remove its values from rows, templates, and view settings.",
    inputSchema: {
      databaseId: z.string().describe("Database page id"),
      property: z.string().describe("Property name or id"),
    },
  },
  async ({ databaseId, property }) => {
    try {
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
      if (db.isLocked) return ok(lockedPageMessage(db));
      const props = await eb.dbProperties(databaseId);
      const prop = propertyByKey(props, property);
      if (!prop) return ok(`Property "${property}" not found in ${titleOf(db)}.`);
      if (prop.type === "title") return ok("The title property cannot be deleted.");

      const result = await eb.del("db_properties", prop.id, { databaseId });
      const cleanup = result?.cleanup ?? {};

      return ok(
        `Deleted property "${prop.name}" from ${titleOf(db)}.\n` +
          `Cleaned ${cleanup.rows ?? 0} row value(s), ${cleanup.views ?? 0} view setting(s), ` +
          `${cleanup.templates ?? 0} template value(s), ${cleanup.properties ?? 0} dependent property config(s).`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "_notion_update_data_source",
  {
    title: "Update data source",
    description:
      "Notion-compatible data source schema/title/trash update. Hanji MCP is account-scoped, so workspace_id is required. Supports ADD/DROP/RENAME/ALTER COLUMN DDL for Hanji database properties.",
    inputSchema: {
      workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
      teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
      data_source_id: z.string().describe("collection:// URI, data source id, or single-source database id"),
      title: z.string().optional(),
      description: z.string().optional(),
      is_inline: z.boolean().optional(),
      in_trash: z.boolean().optional(),
      statements: z.string().optional().describe("Semicolon-separated DDL statements"),
    },
  },
  async ({ workspace_id, teamspace_id, data_source_id, title, description, is_inline, in_trash, statements }) => {
    try {
      const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_update_data_source");
      if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
      const databaseId = stripHanjiId(data_source_id);
      const db = await eb.getOne("pages", databaseId);
      if (!db || db.kind !== "database") return ok(`Data source ${data_source_id} not found.`);
      const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, db, "_notion_update_data_source", "Data source");
      if (matched.errorResult) return matched.errorResult;
      if (db.isLocked && in_trash !== true) return ok(lockedPageMessage(db));
      const notes = [];

      if (title !== undefined) await eb.update("pages", databaseId, { title, ...pageEditAudit() });
      if (in_trash === true) {
        await trashPageTree(databaseId);
      } else if (in_trash === false) {
        await restorePageTree(databaseId);
      }
      if (description !== undefined) notes.push("Hanji does not currently store a separate data-source description field.");
      if (is_inline !== undefined) notes.push("Hanji stores inline display on the page block, not on the data source.");

      if (statements?.trim()) {
        const ops = parseNotionDdlStatements(statements);
        let props = await eb.dbProperties(databaseId);
        for (const op of ops) {
          if (op.action === "add") {
            if (op.property.type === "title") throw new Error("Cannot add a second title property.");
            const duplicate = propertyByKey(props, op.property.name);
            if (duplicate) throw new Error(`Property "${op.property.name}" already exists.`);
            const record = databasePropertyRecordFromInput(
              databaseId,
              op.property,
              props.reduce((max, prop) => Math.max(max, prop.position ?? 0), 0) + 1
            );
            await eb.insert("db_properties", record);
            await addPropertyToViews(databaseId, record.id);
            props = await eb.dbProperties(databaseId);
            continue;
          }
          if (op.action === "drop") {
            const prop = propertyByKey(props, op.name);
            if (!prop) throw new Error(`Property "${op.name}" not found.`);
            if (prop.type === "title") throw new Error("Cannot delete the title property.");
            await eb.del("db_properties", prop.id, { databaseId });
            props = await eb.dbProperties(databaseId);
            continue;
          }
          if (op.action === "rename") {
            const prop = propertyByKey(props, op.from);
            if (!prop) throw new Error(`Property "${op.from}" not found.`);
            await eb.update("db_properties", prop.id, { name: op.to }, { databaseId });
            props = await eb.dbProperties(databaseId);
            continue;
          }
          if (op.action === "alter") {
            const prop = propertyByKey(props, op.name);
            if (!prop) throw new Error(`Property "${op.name}" not found.`);
            if (prop.type === "title" || op.property.type === "title") throw new Error("Cannot alter title property type.");
            await eb.update(
              "db_properties",
              prop.id,
              {
                type: op.property.type ?? prop.type,
                description: op.property.description ?? prop.description ?? null,
                config: propertyConfigForInput(op.property.type ?? prop.type, op.property, databaseId),
              },
              { databaseId }
            );
            props = await eb.dbProperties(databaseId);
          }
        }
      }

      const updated = await eb.getOne("pages", databaseId);
      const payload = await notionDataSourceFetchPayload(updated ?? db);
      return ok(`${payload.text}${notes.length ? `\n\nNotes:\n- ${notes.join("\n- ")}` : ""}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "get_page",
  {
    title: "Get page",
    description: "Read a page's content as Markdown, including its title and metadata.",
    inputSchema: { pageId: z.string() },
  },
  async ({ pageId }) => {
    try {
      const page = await eb.getOne("pages", pageId);
      if (!page || !page.id) return ok(`Page ${pageId} not found.`);
      const blocks = await eb.blocks(pageId);
      const body = blocksToMarkdown(blocks);
      const header = `# ${titleOf(page)}\n\n## Metadata\n${pageMetadataLines(page).join("\n")}\n`;
      return ok(header + "\n## Content\n" + (body || "_(empty page)_"));
    } catch (e) {
      return fail(e);
    }
  }
);

const NOTION_CREATE_PAGES_TOOL = {
  title: "Create pages",
  description:
    "Notion-compatible page creation. Hanji MCP is account-scoped, so workspace_id is required. Accepts a Notion-style parent object with page_id, database_id, or data_source_id and page objects with properties/content/icon/cover/template_id.",
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

registerToolAliases(["create_pages", "_notion_create_pages"], NOTION_CREATE_PAGES_TOOL, handleNotionCreatePages);

server.registerTool(
  "create_page",
  {
    title: "Create page",
    description:
      "Create a new page. Optionally nest it under a parent page, set page appearance, and seed it with Markdown content.",
    inputSchema: {
      title: z.string().describe("Page title"),
      parentId: z.string().optional().describe("Parent page id; omit for a top-level page"),
      icon: z.string().optional().describe("Emoji icon or image URL. Pass an empty string for no icon."),
      iconType: z.enum(PAGE_ICON_TYPES).optional().describe("Icon type. Defaults to image for URLs and emoji otherwise."),
      cover: z.string().optional().describe("Cover image URL or CSS gradient. Pass an empty string for no cover."),
      coverPosition: z.number().min(0).max(100).optional().describe("Cover vertical position from 0 to 100"),
      workspaceId: z.string().optional().describe("Optional workspace id; defaults to the current workspace"),
      font: z.enum(PAGE_FONTS).optional().describe("Page font"),
      smallText: z.boolean().optional().describe("Use Notion-style small text"),
      fullWidth: z.boolean().optional().describe("Use the full-width page layout"),
      locked: z.boolean().optional().describe("Create the page locked"),
      content: z.string().optional().describe("Initial body content as Markdown"),
    },
  },
  async ({ title, parentId, icon, iconType, cover, coverPosition, workspaceId, font, smallText, fullWidth, locked, content }) => {
    try {
      const ws = workspaceId ? { id: workspaceId } : await eb.workspace();
      const pages = await eb.pageProjection({ workspaceId: ws.id });
      const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
      if (parentId) {
        const parent = pagesById[parentId];
        if (!parent || parent.inTrash) return ok(`Parent page ${parentId} not found.`);
        if (parent.kind !== "page") return ok(`Parent ${parentId} is not a page.`);
        if (parent.isLocked) return ok(lockedPageMessage(parent));
      }
      const id = eb.newId();
      const iconPatch = pageIconPatch({ icon, iconType });
      // Position = max sibling position + 1 (stable append order; no collisions).
      const siblings = pages.filter((p) =>
        parentId ? p.parentId === parentId : p.parentType === "workspace" || p.parentId == null
      );
      const position = siblings.reduce((m, p) => Math.max(m, p.position ?? 0), 0) + 1;
      await eb.insert("pages", {
        id,
        workspaceId: ws.id,
        parentId: parentId ?? null,
        parentType: parentId ? "page" : "workspace",
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
        ...iconPatch,
        ...pagePresentationPatch({ cover, coverPosition, font, smallText, fullWidth, locked }),
      });
      let added = 0;
      if (content) added = await appendMarkdown(id, content);
      return ok(`Created page "${title}" (id: ${id})${added ? `, added ${added} blocks` : ""}.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_page_templates",
  {
    title: "List page templates",
    description: "List built-in local page templates available in the web sidebar.",
    inputSchema: {
      category: z.string().optional().describe("Optional category filter, e.g. Personal or Work"),
    },
  },
  async ({ category }) => {
    try {
      const needle = String(category ?? "").trim().toLowerCase();
      const templates = needle
        ? PAGE_TEMPLATES.filter((template) => template.category.toLowerCase() === needle)
        : PAGE_TEMPLATES;
      if (templates.length === 0) return ok(`No page templates${category ? ` in ${category}` : ""}.`);
      return ok(
        templates
          .map(
            (template) =>
              `- ${template.icon} ${template.title}  id: ${template.id}  category: ${template.category}  blocks: ${countTemplateBlocks(template.blocks)}`
          )
          .join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "create_page_from_template",
  {
    title: "Create page from template",
    description: "Create a top-level page from one of the built-in local page templates.",
    inputSchema: {
      templateId: z.string().describe("Template id from list_page_templates"),
      workspaceId: z.string().optional().describe("Optional workspace id; defaults to the current workspace"),
      title: z.string().optional().describe("Optional custom page title; defaults to the template title"),
    },
  },
  async ({ templateId, workspaceId, title }) => {
    try {
      const template = PAGE_TEMPLATES.find((item) => item.id === templateId);
      if (!template) return ok(`Template ${templateId} not found. Call list_page_templates first.`);
      const ws = workspaceId ? { id: workspaceId } : await eb.workspace();
      const id = eb.newId();
      const pages = await eb.pageProjection({ workspaceId: ws.id });
      const position =
        pages
          .filter((page) => page.parentType === "workspace" || page.parentId == null)
          .reduce((max, page) => Math.max(max, page.position ?? 0), 0) + 1;
      const pageTitle = title ?? template.title;
      await eb.insert("pages", {
        id,
        workspaceId: ws.id,
        parentId: null,
        parentType: "workspace",
        kind: "page",
        title: pageTitle,
        icon: template.icon,
        iconType: "emoji",
        position,
        isFavorite: false,
        isPublic: false,
        inTrash: false,
        font: "default",
        smallText: false,
        fullWidth: false,
        backlinksDisplay: "default",
        pageCommentsDisplay: "default",
        ...pageCreateAudit(),
      });
      const inserted = await insertTemplateBlocks(id, template.blocks);
      return ok(`Created page "${pageTitle}" from ${template.title} (id: ${id}), added ${inserted.length} blocks.`);
    } catch (e) {
      return fail(e);
    }
  }
);

const NOTION_DUPLICATE_PAGE_TOOL = {
  title: "Duplicate page",
  description:
    "Duplicate a page subtree. Hanji MCP is account-scoped, so workspace_id is required. Copies child pages, blocks, database schemas, views, templates, and rows with internal links remapped where possible.",
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

registerToolAliases(["duplicate_page", "_notion_duplicate_page"], NOTION_DUPLICATE_PAGE_TOOL, handleNotionDuplicatePage);

server.registerTool(
  "set_page_lock",
  {
    title: "Set page lock",
    description: "Lock or unlock a page. Locked pages can be read, moved, favorited, or trashed, but not edited.",
    inputSchema: {
      pageId: z.string(),
      locked: z.boolean().describe("true to lock the page; false to unlock it"),
    },
  },
  async ({ pageId, locked }) => {
    try {
      const page = await eb.getOne("pages", pageId);
      if (!page || !page.id) return ok(`Page ${pageId} not found.`);
      await eb.update("pages", pageId, { isLocked: locked, ...pageEditAudit() });
      return ok(`${locked ? "Locked" : "Unlocked"} "${titleOf(page)}".`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "set_page_favorite",
  {
    title: "Set page favorite",
    description:
      "Add or remove a page from Favorites. This mirrors the web app's star state and is allowed even when a page is locked.",
    inputSchema: {
      pageId: z.string(),
      favorite: z.boolean().describe("true to add the page to Favorites; false to remove it"),
    },
  },
  async ({ pageId, favorite }) => {
    try {
      const page = await eb.getOne("pages", pageId);
      if (!page || !page.id) return ok(`Page ${pageId} not found.`);
      const updated = await eb.update("pages", pageId, { isFavorite: favorite, ...pageEditAudit() });
      return ok(`${favorite ? "Added" : "Removed"} "${titleOf(updated)}" ${favorite ? "to" : "from"} Favorites.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "set_page_verification",
  {
    title: "Set page verification",
    description:
      "Mark a page as verified, or remove verification. This mirrors Notion's page verification metadata and is allowed even when a page is locked.",
    inputSchema: {
      pageId: z.string(),
      verified: z.boolean().describe("true to verify the page; false to remove verification"),
      expiresAt: z.string().optional().describe("Optional ISO timestamp when verification expires. Omit for no expiry."),
      verifiedBy: z.string().optional().describe("Optional verifier id/name; defaults to mcp-local"),
    },
  },
  async ({ pageId, verified, expiresAt, verifiedBy }) => {
    try {
      const page = await eb.getOne("pages", pageId);
      if (!page || !page.id) return ok(`Page ${pageId} not found.`);
      const patch = verified
        ? {
            verifiedAt: new Date().toISOString(),
            verifiedBy: verifiedBy || MCP_ACTOR,
            verificationExpiresAt: expiresAt || null,
          }
        : {
            verifiedAt: null,
            verifiedBy: null,
            verificationExpiresAt: null,
          };
      const updated = await eb.update("pages", pageId, { ...patch, ...pageEditAudit() });
      return ok(`${verified ? "Verified" : "Removed verification for"} "${titleOf(updated)}".`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "set_page_web_sharing",
  {
    title: "Set page web sharing",
    description:
      "Enable or disable Notion-style Share to web through the backend sharing API. Shared pages appear in the web app's Shared sidebar section.",
    inputSchema: {
      pageId: z.string(),
      public: z.boolean().describe("true to enable Share to web; false to make the page private again"),
      expiresAt: z
        .string()
        .nullable()
        .optional()
        .describe("Optional ISO timestamp, duration like 7d/24h, or null/never to clear public link expiration."),
      expiresIn: z
        .string()
        .optional()
        .describe("Optional duration like 24h, 7d, or 30d. Ignored when expiresAt is provided."),
    },
  },
  async ({ pageId, public: isPublic, expiresAt, expiresIn }) => {
    try {
      const opts = {};
      if (expiresAt !== undefined) opts.expiresAt = expiresAt;
      else if (expiresIn !== undefined) opts.expiresIn = expiresIn;
      const result = await eb.setPageWebSharing(pageId, isPublic, opts);
      return ok(
        `${isPublic ? "Enabled Share to web for" : "Disabled Share to web for"} "${titleOf(result.page)}".\n` +
          pageAccessLines(result).join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_page_access",
  {
    title: "List page access",
    description:
      "List a page's backend-backed web sharing state and explicit page permissions.",
    inputSchema: {
      pageId: z.string(),
    },
  },
  async ({ pageId }) => {
    try {
      const result = await eb.pageAccess(pageId);
      return ok(`Access for "${titleOf(result.page)}":\n${pageAccessLines(result).join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "get_shared_page",
  {
    title: "Get shared page",
    description:
      "Read a public Share to web page by /share/:shareId token through the backend public sharing API.",
    inputSchema: {
      shareId: z.string().describe("The token from a /share/:shareId URL"),
    },
  },
  async ({ shareId }) => {
    try {
      const result = await eb.publicSharedPage(shareId);
      const rootBlocks = (result.blocks ?? [])
        .filter((block) => block.pageId === result.page.id)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const markdown = blocksToMarkdown(rootBlocks);
      return ok(
        `# ${titleOf(result.page)}\n\n` +
          `page id: ${result.page.id}\n` +
          `share id: ${result.shareLink.token}\n` +
          `included pages: ${(result.pages ?? []).length}\n` +
          `included blocks: ${(result.blocks ?? []).length}\n\n` +
          (markdown || "(empty page)")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "prepare_file_upload",
  {
    title: "Prepare file upload",
    description:
      "Create a backend-validated EdgeBase file upload grant for a workspace, page, block, database, database property, or database template target.",
    inputSchema: {
      workspaceId: z.string().optional(),
      pageId: z.string().optional(),
      blockId: z.string().optional(),
      databaseId: z.string().optional(),
      propertyId: z.string().optional(),
      templateId: z.string().optional(),
      scope: z.string().optional().describe("Upload scope, such as blocks/files, blocks/images, or database/files"),
      name: z.string().describe("Original file name"),
      size: z.number().int().positive().describe("File size in bytes"),
      contentType: z.string().optional().describe("MIME content type, such as text/plain"),
    },
  },
  async ({ workspaceId, pageId, blockId, databaseId, propertyId, templateId, scope, name, size, contentType }) => {
    try {
      const routedWorkspaceId = workspaceId || (await eb.workspace()).id;
      const result = await eb.prepareFileUpload({
        workspaceId: routedWorkspaceId,
        pageId,
        blockId,
        databaseId,
        propertyId,
        templateId,
        scope,
        name,
        size,
        contentType,
      });
      return ok(
        `Prepared upload grant for "${result.upload?.name || name}".\n` +
          fileUploadLines(result.upload).join("\n") +
          `\nupload url: ${result.uploadUrl || "not available in this runtime"}` +
          `\nupload expires: ${result.uploadExpiresAt || result.upload?.expiresAt || "no"}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "complete_file_upload",
  {
    title: "Complete file upload",
    description:
      "Verify a previously uploaded object and finalize its backend upload record. The workspace-qualified key is required for deterministic routing.",
    inputSchema: {
      uploadId: z.string(),
      key: z.string().describe("Workspace-qualified key beginning with workspaces/<workspaceId>/"),
      url: z.string().optional(),
    },
  },
  async ({ uploadId, key, url }) => {
    try {
      if (!key.startsWith("workspaces/")) {
        throw new Error("Provide a workspace-qualified storage key.");
      }
      const file = await eb.completeFileUpload({ id: uploadId, key, url });
      return ok(`Completed file "${file.name || file.key}".\n${fileUploadLines(file).join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_files",
  {
    title: "List files",
    description:
      "List EdgeBase-backed file upload records for the current workspace through the backend file API.",
    inputSchema: {
      workspaceId: z.string().optional(),
      pageId: z.string().optional(),
      blockId: z.string().optional(),
      databaseId: z.string().optional(),
      propertyId: z.string().optional(),
      templateId: z.string().optional(),
      scope: z.string().optional().describe("Optional upload scope, such as database/files or blocks/images"),
      status: z.enum(FILE_UPLOAD_STATUSES).optional(),
      includeDeleted: z.boolean().optional(),
    },
  },
  async ({ workspaceId, pageId, blockId, databaseId, propertyId, templateId, scope, status, includeDeleted }) => {
    try {
      const routedWorkspaceId = workspaceId || (await eb.workspace()).id;
      const files = await eb.listFiles({
        workspaceId: routedWorkspaceId,
        pageId,
        blockId,
        databaseId,
        propertyId,
        templateId,
        scope,
        status,
        includeDeleted,
      });
      if (files.length === 0) return ok("No files found.");
      return ok(files.map((file) => fileUploadLines(file).join("\n")).join("\n\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "delete_file",
  {
    title: "Delete file",
    description:
      "Delete an EdgeBase-backed stored file by workspace-qualified storage key, or by upload id together with workspaceId.",
    inputSchema: {
      workspaceId: z.string().optional(),
      uploadId: z.string().optional(),
      key: z.string().optional().describe("Workspace-qualified key beginning with workspaces/<workspaceId>/"),
    },
  },
  async ({ workspaceId, uploadId, key }) => {
    try {
      if (!key && !(workspaceId && uploadId)) {
        throw new Error("Provide a workspace-qualified key, or provide both workspaceId and uploadId.");
      }
      if (key && !key.startsWith("workspaces/")) {
        throw new Error("Provide a workspace-qualified storage key.");
      }
      const file = await eb.deleteFile({ workspaceId, uploadId, key });
      return ok(`Deleted file "${file.name || file.key}".\n${fileUploadLines(file).join("\n")}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "cleanup_expired_files",
  {
    title: "Cleanup expired files",
    description:
      "Expire pending file upload grants whose signed upload window has elapsed, deleting any orphaned stored objects the actor can edit.",
    inputSchema: {
      workspaceId: z.string().optional(),
      limit: z.number().int().positive().max(1000).optional(),
      dryRun: z.boolean().optional(),
    },
  },
  async ({ workspaceId, limit, dryRun }) => {
    try {
      const routedWorkspaceId = workspaceId || (await eb.workspace()).id;
      const result = await eb.cleanupExpiredFiles({ workspaceId: routedWorkspaceId, limit, dryRun });
      const files = result.expired ?? [];
      if (files.length === 0) {
        return ok(
          `${result.dryRun ? "Dry run" : "Cleanup"} found no expired pending file uploads.\n` +
            `workspace id: ${result.workspaceId}\nscanned: ${result.scanned ?? 0}`
        );
      }
      return ok(
        `${result.dryRun ? "Dry run" : "Cleaned up"} ${files.length} expired file upload${files.length === 1 ? "" : "s"}.\n` +
          `workspace id: ${result.workspaceId}\nscanned: ${result.scanned ?? files.length}\n\n` +
          files.map((file) => fileUploadLines(file).join("\n")).join("\n\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "get_file_report",
  {
    title: "Get file report",
    description:
      "Read workspace or organization file usage analytics and recent file maintenance runs through the backend file API. Requires workspace admin or organization admin access.",
    inputSchema: {
      workspaceId: z.string().optional(),
      organizationId: z.string().optional(),
      maintenanceLimit: z.number().int().positive().max(50).optional(),
    },
  },
  async ({ workspaceId, organizationId, maintenanceLimit }) => {
    try {
      if (workspaceId && organizationId) throw new Error("Provide workspaceId or organizationId, not both.");
      const routedWorkspaceId = workspaceId || (!organizationId ? (await eb.workspace()).id : undefined);
      const report = await eb.fileReport({ workspaceId: routedWorkspaceId, organizationId, maintenanceLimit });
      return ok(fileReportLines(report).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_notifications",
  {
    title: "List notifications",
    description:
      "List the current user's persisted Hanji notification inbox through the backend notification API.",
    inputSchema: {
      workspaceId: z.string().optional(),
      includeRead: z.boolean().optional(),
      kind: z.enum(NOTIFICATION_KINDS).optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
  },
  async ({ workspaceId, includeRead, kind, limit }) => {
    try {
      const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
      const result = await eb.listNotifications({
        workspaceId: workspace.id,
        includeRead,
        kind,
        limit,
      });
      return ok(notificationListLines(result).join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "mark_notifications_read",
  {
    title: "Mark notifications read",
    description:
      "Mark one or more persisted notifications read by notification id or activity key through the backend notification API.",
    inputSchema: {
      workspaceId: z.string().optional(),
      notificationIds: z.array(z.string()).optional(),
      activityKeys: z.array(z.string()).optional(),
    },
  },
  async ({ workspaceId, notificationIds, activityKeys }) => {
    try {
      if ((!notificationIds || notificationIds.length === 0) && (!activityKeys || activityKeys.length === 0)) {
        throw new Error("Provide notificationIds or activityKeys.");
      }
      const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
      const result = await eb.markNotificationsRead({
        workspaceId: workspace.id,
        notificationIds,
        activityKeys,
      });
      const updated = result.updated ?? [];
      return ok(
        `Marked ${updated.length} notification${updated.length === 1 ? "" : "s"} read.\n` +
          notificationListLines(result).join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "mark_all_notifications_read",
  {
    title: "Mark all notifications read",
    description:
      "Mark every persisted notification read for the current user in a workspace through the backend notification API.",
    inputSchema: {
      workspaceId: z.string().optional(),
    },
  },
  async ({ workspaceId }) => {
    try {
      const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
      const result = await eb.markAllNotificationsRead({ workspaceId: workspace.id });
      const updated = result.updated ?? [];
      return ok(
        `Marked ${updated.length} notification${updated.length === 1 ? "" : "s"} read.\n` +
          notificationListLines(result).join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "create_file_download_url",
  {
    title: "Create file download URL",
    description:
      "Create a short-lived signed download URL for an EdgeBase-backed file through the backend file API.",
    inputSchema: {
      workspaceId: z.string().optional(),
      uploadId: z.string().optional(),
      key: z.string().optional().describe("Workspace-qualified key beginning with workspaces/<workspaceId>/"),
      expiresIn: z.string().optional().describe("Duration such as 15m, 1h, or 1d. Defaults to 1h."),
    },
  },
  async ({ workspaceId, uploadId, key, expiresIn }) => {
    try {
      if (!key && !(workspaceId && uploadId)) {
        throw new Error("Provide a workspace-qualified key, or provide both workspaceId and uploadId.");
      }
      if (key && !key.startsWith("workspaces/")) {
        throw new Error("Provide a workspace-qualified storage key.");
      }
      const result = await eb.fileDownloadUrl({ workspaceId, uploadId, key, expiresIn });
      return ok(
        `Download URL for "${result.upload?.name || result.upload?.key || key || uploadId}":\n` +
          `${result.url}\nexpires: ${result.expiresAt}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "grant_page_access",
  {
    title: "Grant page access",
    description:
      "Grant backend-backed page access to a user, email, group, or integration.",
    inputSchema: {
      pageId: z.string(),
      label: z.string().describe("Display label or email for the grantee"),
      role: z.enum(SHARE_ROLES).describe("Permission role"),
      principalType: z.enum(SHARE_PRINCIPAL_TYPES).optional().describe("Defaults to email; use group for organization groups"),
      principalId: z.string().optional().describe("Stable grantee id; for groups, pass the organization group id"),
    },
  },
  async ({ pageId, label, role, principalType, principalId }) => {
    try {
      const result = await eb.invitePageAccess(pageId, { label, role, principalType, principalId });
      return ok(
        `Granted ${shareRoleLabel(role)} access to ${label} on "${titleOf(result.page)}".\n` +
          pageAccessLines(result).join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "update_page_access",
  {
    title: "Update page access",
    description: "Update an existing page permission's role by permission id.",
    inputSchema: {
      permissionId: z.string(),
      role: z.enum(SHARE_ROLES),
    },
  },
  async ({ permissionId, role }) => {
    try {
      const result = await eb.updatePageAccess(permissionId, role);
      return ok(
        `Updated page access to ${shareRoleLabel(role)}.\n` +
          pageAccessLines(result).join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "revoke_page_access",
  {
    title: "Revoke page access",
    description: "Remove an explicit page permission by permission id.",
    inputSchema: {
      permissionId: z.string(),
    },
  },
  async ({ permissionId }) => {
    try {
      const result = await eb.removePageAccess(permissionId);
      return ok(
        `Revoked page access ${permissionId}.\n` +
          (result.page ? pageAccessLines(result).join("\n") : "permissions: none")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

const NOTION_UPDATE_PAGE_TOOL = {
  title: "Update page",
  description:
    "Update a page. Hanji MCP is account-scoped, so workspace_id is required. Supports Notion-compatible commands: update_properties, insert_content, update_content, replace_content, apply_template, and update_verification.",
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
    content: z.string().optional(),
    new_str: z.string().optional(),
    content_updates: z.array(z.object({
      old_str: z.string(),
      new_str: z.string(),
      replace_all_matches: z.boolean().optional(),
    })).optional(),
    position: z.object({ type: z.enum(["start", "end"]) }).optional(),
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

async function handleNotionUpdatePage({
  workspace_id,
  teamspace_id,
  pageId,
  page_id,
  command,
  title,
  properties,
  content,
  new_str,
  content_updates,
  position,
  template_id,
  verification_status,
  verification_expiry_days,
  icon,
  iconType,
  cover,
  coverPosition,
  font,
  smallText,
  fullWidth,
  backlinksDisplay,
  pageCommentsDisplay,
  locked,
}) {
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_update_page");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const targetPageId = stripHanjiId(pageId ?? page_id);
    if (!targetPageId) throw new Error("Provide pageId or page_id.");
    const page = await eb.getOne("pages", targetPageId);
    if (!page || !page.id) return ok(`Page ${targetPageId} not found.`);
    const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, page, "_notion_update_page", "Page");
    if (matched.errorResult) return matched.errorResult;
    if (page.isLocked && locked !== false && command !== "update_verification") return ok(lockedPageMessage(page));

    if (command) {
      if (command === "update_properties") {
        const patch = {};
        if (page.parentType === "database" && page.parentId) {
          const props = await eb.dbProperties(page.parentId);
          const { patch: rowPatch, unknown, readonly } = rowPatchFromProperties(props, properties ?? {});
          if (Object.keys(rowPatch.properties ?? {}).length || rowPatch.title !== undefined) {
            const next = {};
            if (rowPatch.title !== undefined) next.title = rowPatch.title;
            if (Object.keys(rowPatch.properties ?? {}).length) {
              next.properties = persistableDatabaseRowProperties({
                ...(page.properties ?? {}),
                ...(rowPatch.properties ?? {}),
              });
            }
            await eb.updateDatabaseRow(page.id, { ...next, ...pageEditAudit() });
          }
          Object.assign(patch, pageIconPatch({ icon, iconType }, page), pagePresentationPatch({ cover }));
          if (Object.keys(patch).length) await eb.update("pages", page.id, { ...patch, ...pageEditAudit() });
          return okJson({
            id: page.id,
            url: pageUrl(page.id),
            ignored_properties: unknown,
            skipped_readonly_properties: readonly,
          });
        }
        const nextTitle = properties?.title ?? properties?.Name ?? properties?.name;
        if (nextTitle !== undefined) patch.title = String(nextTitle);
        Object.assign(patch, pageIconPatch({ icon, iconType }, page), pagePresentationPatch({ cover }));
        if (Object.keys(patch).length) await eb.update("pages", page.id, { ...patch, ...pageEditAudit() });
        return okJson({ id: page.id, url: pageUrl(page.id) });
      }

      if (command === "insert_content") {
        const markdown = content ?? new_str ?? "";
        if (!markdown.trim()) throw new Error("insert_content requires content.");
        if (position?.type === "start") {
          const rootBlocks = (await eb.blocks(page.id)).filter((block) => !block.parentId);
          const firstPosition = rootBlocks.reduce((min, block) => Math.min(min, block.position ?? 0), 1);
          const parsed = markdownToBlocks(markdown);
          await insertMarkdownBlocks(page.id, parsed, firstPosition - parsed.length - 1);
        } else {
          await appendMarkdown(page.id, markdown);
        }
        await eb.update("pages", page.id, pageEditAudit());
        return okJson({ id: page.id, url: pageUrl(page.id) });
      }

      if (command === "replace_content") {
        const markdown = new_str ?? content ?? "";
        await replaceMarkdown(page.id, markdown);
        await eb.update("pages", page.id, pageEditAudit());
        return okJson({ id: page.id, url: pageUrl(page.id) });
      }

      if (command === "update_content") {
        const updates = content_updates ?? [];
        if (!updates.length) throw new Error("update_content requires content_updates.");
        const blocks = await eb.blocks(page.id);
        let markdown = blocksToMarkdown(blocks);
        for (const update of updates) {
          if (!markdown.includes(update.old_str)) {
            throw new Error("Could not find old_str in page content.");
          }
          markdown = update.replace_all_matches
            ? markdown.split(update.old_str).join(update.new_str)
            : markdown.replace(update.old_str, update.new_str);
        }
        // Apply as an id-preserving diff instead of replaceMarkdown's
        // delete-all+reinsert so unedited blocks keep their ids (comment
        // anchors, buttons, and non-markdown media survive a targeted edit).
        await updateMarkdownPreservingIds(page.id, markdown, blocks);
        await eb.update("pages", page.id, pageEditAudit());
        return okJson({ id: page.id, url: pageUrl(page.id) });
      }

      if (command === "apply_template") {
        if (!template_id) throw new Error("apply_template requires template_id.");
        let inserted = [];
        if (page.parentType === "database" && page.parentId) {
          const template = (await eb.dbTemplates(page.parentId)).find((item) => item.id === template_id);
          if (!template) throw new Error(`Template ${template_id} not found.`);
          inserted = await insertTemplateBlocks(page.id, template.blocks ?? []);
        } else {
          const template = PAGE_TEMPLATES.find((item) => item.id === template_id);
          if (!template) throw new Error(`Template ${template_id} not found.`);
          inserted = await insertTemplateBlocks(page.id, template.blocks ?? []);
        }
        await eb.update("pages", page.id, pageEditAudit());
        return okJson({ id: page.id, url: pageUrl(page.id), appended_blocks: inserted.length });
      }

      if (command === "update_verification") {
        const verified = verification_status === "verified";
        const expiresAt = verified && verification_expiry_days
          ? new Date(Date.now() + verification_expiry_days * 24 * 60 * 60 * 1000).toISOString()
          : null;
        await eb.update("pages", page.id, {
          verifiedAt: verified ? new Date().toISOString() : null,
          verifiedBy: verified ? MCP_ACTOR : null,
          verificationExpiresAt: verified ? expiresAt : null,
          ...pageEditAudit(),
        });
        return okJson({ id: page.id, url: pageUrl(page.id), verification_status: verified ? "verified" : "unverified" });
      }
    }

    const patch = {};
    if (title !== undefined) patch.title = title;
    Object.assign(patch, pageIconPatch({ icon, iconType }, page));
    Object.assign(
      patch,
      pagePresentationPatch({
        cover,
        coverPosition,
        font,
        smallText,
        fullWidth,
        backlinksDisplay,
        pageCommentsDisplay,
        locked,
      })
    );
    if (Object.keys(patch).length === 0) return ok(`No changes supplied for "${titleOf(page)}".`);
    const updated = await eb.update("pages", page.id, { ...patch, ...pageEditAudit() });
    return ok(`Updated "${titleOf(updated)}".`);
  } catch (e) {
    return fail(e);
  }
}

registerToolAliases(["update_page", "_notion_update_page"], NOTION_UPDATE_PAGE_TOOL, handleNotionUpdatePage);

server.registerTool(
  "add_content",
  {
    title: "Add content",
    description:
      "Append Markdown content to a page as blocks (headings, lists, to-dos, quotes, code, etc.).",
    inputSchema: { pageId: z.string(), markdown: z.string().describe("Markdown to append") },
  },
  async ({ pageId, markdown }) => {
    try {
      const page = await eb.getOne("pages", pageId);
      if (!page || !page.id) return ok(`Page ${pageId} not found.`);
      if (page.inTrash) return ok(`"${titleOf(page)}" is in trash. Restore it before editing.`);
      if (page.isLocked) return ok(lockedPageMessage(page));
      const added = await appendMarkdown(pageId, markdown);
      await eb.update("pages", pageId, pageEditAudit());
      return ok(`Appended ${added} block(s) to "${titleOf(page)}".`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "replace_page_content",
  {
    title: "Replace page content",
    description:
      "Replace all existing blocks in a page with Markdown content. Use get_page first if you need to preserve any current text.",
    inputSchema: {
      pageId: z.string(),
      markdown: z.string().describe("Markdown that should become the full page body"),
    },
  },
  async ({ pageId, markdown }) => {
    try {
      const page = await eb.getOne("pages", pageId);
      if (!page || !page.id) return ok(`Page ${pageId} not found.`);
      if (page.inTrash) return ok(`"${titleOf(page)}" is in trash. Restore it before editing.`);
      if (page.isLocked) return ok(lockedPageMessage(page));
      const count = await replaceMarkdown(pageId, markdown);
      await eb.update("pages", pageId, pageEditAudit());
      return ok(`Replaced content of "${titleOf(page)}" with ${count} block(s).`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "move_page",
  {
    title: "Move page",
    description:
      "Move a page to the workspace root, under another page, or into a database. Omit parentId for workspace root.",
    inputSchema: {
      pageId: z.string().optional().describe("Page id to move"),
      page_id: z.string().optional().describe("Notion-compatible page id alias"),
      parentId: z.string().optional().describe("Destination parent page/database id; omit for workspace root"),
      parent_id: z.string().optional().describe("Notion-compatible destination parent id alias"),
      parentType: z.enum(PAGE_PARENT_TYPES).optional().describe("Destination type; defaults to page when parentId is set, otherwise workspace"),
      parent_type: z.enum(PAGE_PARENT_TYPES).optional().describe("Notion-compatible destination type alias"),
      afterPageId: z.string().optional().describe("Optional destination sibling to place this page after"),
      after_page_id: z.string().optional().describe("Notion-compatible afterPageId alias"),
      beforePageId: z.string().optional().describe("Optional destination sibling to place this page before"),
      before_page_id: z.string().optional().describe("Notion-compatible beforePageId alias"),
    },
  },
  async ({ pageId, page_id, parentId, parent_id, parentType, parent_type, afterPageId, after_page_id, beforePageId, before_page_id }) => {
    try {
      const targetPageId = stripHanjiId(pageId ?? page_id);
      if (!targetPageId) throw new Error("Provide pageId or page_id.");
      const result = await movePage(targetPageId, {
        parentId: parentId ? stripHanjiId(parentId) : parent_id ? stripHanjiId(parent_id) : undefined,
        parentType: parentType ?? parent_type,
        afterPageId: afterPageId ? stripHanjiId(afterPageId) : after_page_id ? stripHanjiId(after_page_id) : undefined,
        beforePageId: beforePageId ? stripHanjiId(beforePageId) : before_page_id ? stripHanjiId(before_page_id) : undefined,
      });
      if (!result) return ok(`Page ${targetPageId} not found.`);
      const destination =
        result.parentType === "workspace"
          ? "workspace root"
          : `${result.parentType} ${result.parentId}`;
      return ok(`Moved "${titleOf(result.page)}" to ${destination}.`);
    } catch (e) {
      return fail(e);
    }
  }
);

const NOTION_MOVE_PAGES_TOOL = {
  title: "Move pages",
  description:
    "Notion-compatible multi-page move. Hanji MCP is account-scoped, so workspace_id is required. Moves pages/databases to workspace root, under a page, or into a data source/database.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    page_or_database_ids: z.array(z.string()).optional().describe("Page or database ids/URLs to move"),
    page_ids: z.array(z.string()).optional().describe("Alternative page id list"),
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

async function handleNotionMovePages({ workspace_id, teamspace_id, page_or_database_ids, page_ids, page_id, new_parent, parent, after_page_id, before_page_id }) {
  try {
    const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_move_pages");
    if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
    const ids = (page_or_database_ids ?? page_ids ?? (page_id ? [page_id] : []))
      .map(stripHanjiId)
      .filter(Boolean);
    if (ids.length === 0) throw new Error("Provide page_or_database_ids, page_ids, or page_id.");

    const destination = new_parent ?? parent ?? {};
    const type = String(destination.type ?? "").toLowerCase();
    const databaseId = destination.data_source_id ?? destination.database_id;
    const parentPageId = destination.page_id ?? destination.parent_page_id;
    const parentId = databaseId
      ? stripHanjiId(databaseId)
      : parentPageId
        ? stripHanjiId(parentPageId)
        : null;
    const parentType = type === "workspace" || (!databaseId && !parentPageId)
      ? "workspace"
      : databaseId || type === "database" || type === "data_source" || type === "database_id" || type === "data_source_id"
        ? "database"
        : "page";
    if (parentId) {
      const parentPage = await eb.getOne("pages", parentId);
      if (parentPage?.id) {
        const parentMatched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, parentPage, "_notion_move_pages", "Destination parent");
        if (parentMatched.errorResult) return parentMatched.errorResult;
      }
    }
    const moved = [];
    const notFound = [];
    for (const id of ids) {
      const page = await eb.getOne("pages", id);
      if (page?.id) {
        const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, page, "_notion_move_pages", "Page");
        if (matched.errorResult) return matched.errorResult;
      }
      const result = await movePage(id, {
        parentId,
        parentType,
        afterPageId: after_page_id ? stripHanjiId(after_page_id) : undefined,
        beforePageId: before_page_id ? stripHanjiId(before_page_id) : undefined,
      });
      if (!result) {
        notFound.push(id);
        continue;
      }
      moved.push({
        id: result.page.id,
        title: titleOf(result.page),
        url: pageUrl(result.page.id),
        parent: result.parentType === "workspace"
          ? { type: "workspace" }
          : { type: result.parentType, id: result.parentId },
      });
    }
    return okJson({ moved, not_found: notFound });
  } catch (e) {
    return fail(e);
  }
}

registerToolAliases(["move_pages", "_notion_move_pages"], NOTION_MOVE_PAGES_TOOL, handleNotionMovePages);

server.registerTool(
  "list_comments",
  {
    title: "List comments",
    description:
      "List page and block comments for a page. Replies are grouped under their parent comment.",
    inputSchema: {
      pageId: z.string().describe("Page id"),
      includeResolved: z.boolean().optional().describe("Include resolved comments; default false"),
    },
  },
  async ({ pageId, includeResolved = false }) => {
    try {
      const page = await eb.getOne("pages", pageId);
      if (!page || !page.id) return ok(`Page ${pageId} not found.`);
      const [comments, blocks] = await Promise.all([eb.comments(pageId), eb.blocks(pageId)]);
      const blocksById = Object.fromEntries(blocks.map((block) => [block.id, block]));
      const roots = comments
        .filter((comment) => !comment.parentId)
        .filter((comment) => includeResolved || !comment.resolved);
      const repliesByParent = new Map();
      for (const comment of comments) {
        if (!comment.parentId) continue;
        if (!includeResolved && comment.resolved) continue;
        const list = repliesByParent.get(comment.parentId) ?? [];
        list.push(comment);
        repliesByParent.set(comment.parentId, list);
      }
      if (roots.length === 0) {
        return ok(`No ${includeResolved ? "" : "open "}comments on "${titleOf(page)}".`);
      }
      const lines = [`# Comments on ${titleOf(page)}`];
      for (const comment of roots) {
        lines.push(commentLine(comment, { blocksById }));
        for (const reply of repliesByParent.get(comment.id) ?? []) {
          lines.push(commentLine(reply, { blocksById, depth: 1 }));
        }
      }
      return ok(lines.join("\n"));
    } catch (e) {
      return fail(e);
    }
  }
);

const NOTION_GET_COMMENTS_TOOL = {
  title: "Get comments",
  description:
    "Notion-compatible page comments fetch. Hanji MCP is account-scoped, so workspace_id is required. Returns discussions/comments in a compact XML-like payload; returns {} when there are no matching comments.",
  inputSchema: {
    workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
    teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
    page_id: z.string().describe("Page id"),
    include_all_blocks: z.boolean().optional(),
    include_resolved: z.boolean().optional(),
    discussion_id: z.string().optional(),
  },
};

async function handleNotionGetComments({ workspace_id, teamspace_id, page_id, include_resolved = false, discussion_id }) {
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
      .filter((comment) => !wantedDiscussionId || comment.id === wantedDiscussionId);
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

registerToolAliases(["get_comments", "_notion_get_comments"], NOTION_GET_COMMENTS_TOOL, handleNotionGetComments);

const NOTION_CREATE_COMMENT_TOOL = {
  title: "Create comment",
  description:
    "Notion-compatible comment creation. Hanji MCP is account-scoped, so workspace_id is required. Provide page_id and markdown or rich_text. discussion_id replies to an existing thread.",
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
    const text = markdown ?? (rich_text ?? []).map((item) => item?.text?.content ?? item?.plain_text ?? "").join("");
    const cleanText = String(text ?? "").trim();
    if (!cleanText) return ok("Comment text is empty.");
    const comments = await eb.comments(pageId);
    const parentId = discussion_id ? String(discussion_id).split("/").filter(Boolean).at(-1) : null;
    const parent = parentId ? comments.find((comment) => comment.id === parentId) : null;
    if (parentId && !parent) return ok(`Discussion ${discussion_id} not found on page ${pageId}.`);
    const comment = await eb.insert("comments", {
      id: eb.newId(),
      pageId,
      blockId: parent?.blockId ?? null,
      parentId: parent?.id ?? null,
      authorId: MCP_ACTOR,
      body: selection_with_ellipsis
        ? { rich: [{ text: cleanText }], quote: selection_with_ellipsis }
        : { rich: [{ text: cleanText }] },
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

registerToolAliases(["create_comment", "_notion_create_comment"], NOTION_CREATE_COMMENT_TOOL, handleNotionCreateComment);

server.registerTool(
  "add_comment",
  {
    title: "Add comment",
    description:
      "Add a page comment, a block comment, or a reply to an existing comment.",
    inputSchema: {
      pageId: z.string().describe("Page id"),
      text: z.string().describe("Comment text"),
      blockId: z.string().optional().describe("Optional block id for an anchored block comment"),
      parentId: z.string().optional().describe("Optional parent comment id for a reply"),
      quote: z.string().optional().describe("Optional quoted text for context"),
    },
  },
  async ({ pageId, text, blockId, parentId, quote }) => {
    try {
      const page = await eb.getOne("pages", pageId);
      if (!page || !page.id) return ok(`Page ${pageId} not found.`);
      if (page.inTrash) return ok(`"${titleOf(page)}" is in trash. Restore it before commenting.`);
      const [comments, blocks] = await Promise.all([eb.comments(pageId), eb.blocks(pageId)]);
      const parent = parentId ? comments.find((comment) => comment.id === parentId) : undefined;
      if (parentId && !parent) return ok(`Parent comment ${parentId} not found on page ${pageId}.`);
      if (blockId && !blocks.some((block) => block.id === blockId)) {
        return ok(`Block ${blockId} not found on page ${pageId}.`);
      }
      const cleanText = text.trim();
      if (!cleanText) return ok("Comment text is empty.");
      const cleanQuote = quote?.trim();
      const targetBlockId = blockId ?? parent?.blockId ?? null;
      const comment = await eb.insert("comments", {
        id: eb.newId(),
        pageId,
        blockId: targetBlockId,
        parentId: parentId ?? null,
        authorId: MCP_ACTOR,
        body: cleanQuote ? { rich: [{ text: cleanText }], quote: cleanQuote } : { rich: [{ text: cleanText }] },
        resolved: false,
      });
      return ok(
        `Added ${parentId ? "reply" : targetBlockId ? "block comment" : "page comment"} to "${titleOf(page)}".\ncomment id: ${comment.id}`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "resolve_comment",
  {
    title: "Resolve comment",
    description: "Resolve or reopen a comment thread.",
    inputSchema: {
      commentId: z.string().describe("Comment id"),
      resolved: z.boolean().optional().describe("Resolved state; default true"),
    },
  },
  async ({ commentId, resolved = true }) => {
    try {
      const comment = await eb.getOne("comments", commentId);
      if (!comment || !comment.id) return ok(`Comment ${commentId} not found.`);
      const comments = await eb.comments(comment.pageId);
      const childrenByParent = new Map();
      for (const item of comments) {
        if (!item.parentId) continue;
        const list = childrenByParent.get(item.parentId) ?? [];
        list.push(item);
        childrenByParent.set(item.parentId, list);
      }
      const idsToUpdate = new Set();
      const collect = (id) => {
        if (idsToUpdate.has(id)) return;
        idsToUpdate.add(id);
        for (const child of childrenByParent.get(id) ?? []) collect(child.id);
      };
      collect(commentId);
      await Promise.all(
        Array.from(idsToUpdate).map((id) =>
          eb.update("comments", id, { resolved }, { pageId: comment.pageId }),
        ),
      );
      return ok(`${resolved ? "Resolved" : "Reopened"} ${idsToUpdate.size} comment(s) in thread ${commentId}.`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "list_trash",
  {
    title: "List trash",
    description: "List top-level pages currently in trash. Child pages trashed with a parent are grouped under that parent.",
    inputSchema: {},
  },
  async () => {
    try {
      const pages = await eb.allPages();
      const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
      const trashed = pages
        .filter((page) => page.inTrash)
        .filter((page) => !hasTrashedAncestor(pagesById, page))
        .sort((a, b) => String(b.trashedAt ?? "").localeCompare(String(a.trashedAt ?? "")));
      if (trashed.length === 0) return ok("Trash is empty.");
      return ok(
        trashed
          .map((page) => {
            const childCount = collectPageSubtree(pages, page.id).size - 1;
            return `- ${titleOf(page)}${page.kind === "database" ? " [database]" : ""}${
              childCount > 0 ? ` (${childCount} descendant page(s))` : ""
            }  trashed: ${page.trashedAt ?? "unknown"}  id: ${page.id}`;
          })
          .join("\n")
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "trash_page",
  {
    title: "Trash page",
    description: "Move a page and its descendant pages to the trash (soft delete).",
    inputSchema: { pageId: z.string() },
  },
  async ({ pageId }) => {
    try {
      const result = await trashPageTree(pageId);
      if (!result) return ok(`Page ${pageId} not found.`);
      return ok(
        `Moved "${titleOf(result.page)}" to trash` +
          `${result.count > 1 ? ` with ${result.count - 1} descendant page(s)` : ""}.`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "restore_page",
  {
    title: "Restore page",
    description:
      "Restore a page from trash. Descendants trashed in the same operation are restored with it.",
    inputSchema: { pageId: z.string() },
  },
  async ({ pageId }) => {
    try {
      const result = await restorePageTree(pageId);
      if (!result) return ok(`Page ${pageId} not found.`);
      if (result.count === 0) return ok(`"${titleOf(result.page)}" is not in trash.`);
      return ok(
        `Restored "${titleOf(result.page)}"` +
          `${result.count > 1 ? ` with ${result.count - 1} descendant page(s)` : ""}.`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "delete_page_forever",
  {
    title: "Delete page forever",
    description:
      "Permanently delete a page subtree already in trash. The trash step is required and this cannot be undone.",
    inputSchema: { pageId: z.string() },
  },
  async ({ pageId }) => {
    try {
      const result = await deletePageTree(pageId);
      if (!result) return ok(`Page ${pageId} not found.`);
      return ok(
        `Deleted "${titleOf(result.page)}" forever` +
          `${result.count > 1 ? ` with ${result.count - 1} descendant page(s)` : ""}.`
      );
    } catch (e) {
      return fail(e);
    }
  }
);

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
// module (e.g. from unit tests) must not start the server or consume stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the MCP protocol channel)
  console.error("hanji-mcp ready (stdio)");
}
