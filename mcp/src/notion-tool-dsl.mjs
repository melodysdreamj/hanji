import {
  NOTION_CHART_AGGREGATES,
  normalizeNotionChartAggregate,
  notionChartAggregateSupportsProperty,
} from "../../shared/notion-chart-aggregates.mjs";
import {
  HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES,
  notionBoardMainGroupPropertyType,
} from "../../shared/board-group-types.mjs";

function normalizeUuidToken(value) {
  const raw = String(value ?? "").trim();
  const compact = raw.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) return raw;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function stripHanjiId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const collection = raw.match(/^collection:\/\/([0-9a-f-]{32,36})$/i);
  if (collection?.[1]) return normalizeUuidToken(collection[1]);
  const viewUri = raw.match(/^view:\/\/([0-9a-f-]{32,36})$/i);
  if (viewUri?.[1]) return normalizeUuidToken(viewUri[1]);
  const viewParam = raw.match(/[?&]v=([0-9a-f-]{32,36})/i);
  if (viewParam?.[1]) return normalizeUuidToken(viewParam[1]);
  const urlPage = raw.match(/\/(?:p|page|database)\/([0-9a-f-]{32,36})/i);
  if (urlPage?.[1]) return normalizeUuidToken(urlPage[1]);
  const uuid = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid?.[0]) return normalizeUuidToken(uuid[0]);
  const compact = raw.match(/[0-9a-f]{32}/i);
  if (compact?.[0]) return normalizeUuidToken(compact[0]);
  return raw;
}



export function normalizeNotionViewConfig(input = {}) {
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
    map_by: "mapBy",
    dependency_property: "dependencyProperty",
    cover_property: "coverProperty",
    frozen_column_index: "frozenColumnIndex",
    chart_type: "chartType",
    chart_group_by: "chartGroupBy",
    chart_aggregate: "chartAggregate",
    chart_aggregate_by: "chartAggregateBy",
    chart_stack_by: "chartStackBy",
    chart_color: "chartColor",
    chart_height: "chartHeight",
    chart_sort: "chartSort",
    chart_caption: "chartCaption",
    is_form_closed: "formClosed",
    anonymous_submissions: "formAnonymous",
    submission_permissions: "formPermissions",
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

/** @type {Set<string>} */
const NOTION_CHART_AGGREGATE_SET = new Set(NOTION_CHART_AGGREGATES);
const NOTION_CHART_COLORS = new Set([
  "gray",
  "blue",
  "yellow",
  "green",
  "purple",
  "teal",
  "orange",
  "pink",
  "red",
  "auto",
  "colorful",
]);
const NOTION_CHART_HEIGHTS = new Set(["small", "medium", "large", "extra_large"]);
const NOTION_CHART_SORTS = new Set([
  "manual",
  "x_ascending",
  "x_descending",
  "y_ascending",
  "y_descending",
]);
const NOTION_CHART_OPTION_DEFINITIONS = [
  { keyword: "COLOR", values: NOTION_CHART_COLORS, configKey: "chartColor" },
  { keyword: "HEIGHT", values: NOTION_CHART_HEIGHTS, configKey: "chartHeight" },
  { keyword: "SORT", values: NOTION_CHART_SORTS, configKey: "chartSort" },
];
const NOTION_CHART_OPTION_START = /^(?:COLOR|HEIGHT|SORT|STACK\s+BY|CAPTION)\b/i;
const NOTION_COUNT_BY_GUIDANCE = 'CHART AGGREGATE count does not accept BY; use count_values BY "Property".';

function leadingDslValue(value, label) {
  const text = String(value ?? "").trimStart();
  const quoted = text.match(/^(?:"([^"]+)"|'([^']+)')/);
  if (quoted) {
    return {
      value: quoted[1] ?? quoted[2],
      rest: text.slice(quoted[0].length).trimStart(),
    };
  }
  const bare = text.match(/^(\S+)/);
  if (!bare) throw new Error(`${label} requires a value.`);
  return { value: bare[1], rest: text.slice(bare[0].length).trimStart() };
}

function parseNotionChartDirective(directive) {
  const match = String(directive).match(/^CHART\s+(column|bar|line|donut|number)\b(.*)$/i);
  if (!match) return null;
  const config = { chartType: match[1].toLowerCase() };
  let rest = match[2].trim();
  while (rest) {
    let option = rest.match(/^AGGREGATE\s+([a-z_]+)\b(.*)$/i);
    if (option) {
      const aggregate = option[1].toLowerCase();
      if (!NOTION_CHART_AGGREGATE_SET.has(aggregate)) {
        throw new Error(`Unsupported CHART AGGREGATE value: ${option[1]}`);
      }
      config.chartAggregate = aggregate;
      const tail = option[2].trimStart();
      const by = tail.match(/^BY\b\s*/i);
      if (aggregate === "count") {
        if (by || (tail && !NOTION_CHART_OPTION_START.test(tail))) {
          throw new Error(NOTION_COUNT_BY_GUIDANCE);
        }
        rest = tail;
        continue;
      }
      const propertyText = by ? tail.slice(by[0].length) : tail;
      if (!propertyText) {
        throw new Error(`CHART AGGREGATE ${aggregate} requires a property after BY "Property".`);
      }
      if (!by && NOTION_CHART_OPTION_START.test(propertyText)) {
        throw new Error(
          `CHART AGGREGATE ${aggregate} requires a property after BY "Property"; `
          + "use BY when the property name is also a CHART option."
        );
      }
      const property = leadingDslValue(propertyText, `CHART AGGREGATE ${aggregate}`);
      config.chartAggregateBy = property.value;
      rest = property.rest;
      continue;
    }
    for (const { keyword, values, configKey } of NOTION_CHART_OPTION_DEFINITIONS) {
      option = rest.match(new RegExp(`^${keyword}\\s+([a-z_]+)\\b(.*)$`, "i"));
      if (!option) continue;
      const value = option[1].toLowerCase();
      if (!values.has(value)) throw new Error(`Unsupported CHART ${keyword} value: ${option[1]}`);
      config[configKey] = value;
      rest = option[2].trim();
      break;
    }
    if (option) continue;
    option = rest.match(/^STACK\s+BY\s+(.+)$/i);
    if (option) {
      const property = leadingDslValue(option[1], "CHART STACK BY");
      config.chartStackBy = property.value;
      rest = property.rest;
      continue;
    }
    option = rest.match(/^CAPTION\s+(.+)$/i);
    if (option) {
      const caption = leadingDslValue(option[1], "CHART CAPTION");
      config.chartCaption = caption.value;
      rest = caption.rest;
      continue;
    }
    throw new Error(`Unsupported CHART option: ${rest}`);
  }
  return config;
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

function unquoteSqlString(value, label) {
  const trimmed = String(value ?? "").trim();
  const match = trimmed.match(/^'((?:[^']|'')*)'$/s) ?? trimmed.match(/^"((?:[^"]|"")*)"$/s);
  if (!match) throw new Error(`${label} must be quoted.`);
  return match[1].replace(trimmed.startsWith("'") ? /''/g : /""/g, trimmed[0]);
}

function parseDescription(spec) {
  const match = spec.match(/\bCOMMENT\s+('(?:[^']|'')*'|"(?:[^"]|"")*")\s*$/i);
  if (!match) return { typeSpec: spec.trim(), description: undefined };
  return {
    typeSpec: spec.slice(0, match.index).trim(),
    description: unquoteSqlString(match[1], "COMMENT"),
  };
}

function parseOptions(typeSpec) {
  const body = String(typeSpec ?? "").match(/\((.*)\)/s)?.[1] ?? "";
  const allowedColors = new Set(["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);
  return splitTopLevel(body).map((entry) => {
    const name = firstQuoted(entry) || entry.split(":")[0]?.trim();
    const color = entry.match(/:\s*([a-z_]+)\s*$/i)?.[1]?.toLowerCase() ?? "default";
    if (!name) throw new Error(`Could not parse option: ${entry}`);
    if (!allowedColors.has(color)) throw new Error(`Unsupported option color: ${color}.`);
    return { name, color };
  });
}

function parseNotionSqlColumnType(typeSpec, name = "Name") {
  const spec = String(typeSpec ?? "").trim();
  const parsedDescription = parseDescription(spec);
  const upper = spec.toUpperCase();
  const base = { name, description: parsedDescription.description };
  if (!spec || upper.startsWith("RICH_TEXT") || upper.startsWith("TEXT")) return { ...base, type: "rich_text" };
  if (upper.startsWith("TITLE")) return { ...base, type: "title" };
  if (upper.startsWith("DATE")) return { ...base, type: "date" };
  if (upper.startsWith("PEOPLE") || upper.startsWith("PERSON")) return { ...base, type: "person" };
  if (upper.startsWith("CHECKBOX")) return { ...base, type: "checkbox" };
  if (upper.startsWith("URL")) return { ...base, type: "url" };
  if (upper.startsWith("EMAIL")) return { ...base, type: "email" };
  if (upper.startsWith("PHONE_NUMBER") || upper.startsWith("PHONE")) return { ...base, type: "phone" };
  if (/^STATUS\s*$/i.test(spec)) return { ...base, type: "status", options: [] };
  if (upper.startsWith("STATUS")) return { ...base, type: "status", options: parseOptions(spec) };
  if (upper.startsWith("FILES") || upper.startsWith("FILE")) return { ...base, type: "files" };
  if (upper.startsWith("SELECT")) return { ...base, type: "select", options: parseOptions(spec) };
  if (upper.startsWith("MULTI_SELECT")) return { ...base, type: "multi_select", options: parseOptions(spec) };
  if (upper.startsWith("NUMBER")) {
    const numberFormat = spec.match(/\bFORMAT\s+'([^']+)'/i)?.[1] ?? spec.match(/\bFORMAT\s+"([^"]+)"/i)?.[1];
    return { ...base, type: "number", numberFormat: numberFormat ?? "number" };
  }
  if (upper.startsWith("FORMULA")) return { ...base, type: "formula", formula: firstQuoted(spec) };
  if (upper.startsWith("RELATION")) {
    const args = splitTopLevel(spec.match(/\((.*)\)/s)?.[1] ?? "");
    if (!args.length || args.length > 2) throw new Error("RELATION requires a data source id and optional DUAL clause.");
    /** @type {Record<string, any>} */
    const property = { ...base, type: "relation", relationDatabaseId: stripHanjiId(firstQuoted(args[0])) };
    if (args[1]) {
      const dual = args[1].match(/^DUAL(?:\s+("[^"]+"|'[^']+'))?(?:\s+("[^"]+"|'[^']+'))?$/i);
      if (!dual) throw new Error(`Could not parse RELATION DUAL clause: ${args[1]}`);
      property.relatedPropertyId = dual[2] ? firstQuoted(dual[2]) : undefined;
      property.reciprocalName = dual[1] ? firstQuoted(dual[1]) : undefined;
      property.twoWay = true;
    }
    return property;
  }
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
  if (/^PLACE$/i.test(parsedDescription.typeSpec)) {
    return { ...base, type: "place" };
  }
  throw new Error(`Unsupported Notion database column type: ${spec}.`);
}

export function parseNotionCreateTableSchema(schema) {
  const body = String(schema ?? "").match(/CREATE\s+TABLE(?:\s+[^(]+)?\s*\((.*)\)\s*$/is)?.[1];
  if (!body) throw new Error("schema must be a CREATE TABLE (...) statement.");
  /** @type {Array<Record<string, any>>} */
  const properties = splitTopLevel(body).map((column) => {
    const match = column.match(/^\s*"([^"]+)"\s+(.+)$/s) ?? column.match(/^\s*'([^']+)'\s+(.+)$/s);
    if (!match) throw new Error(`Could not parse schema column: ${column}`);
    return parseNotionSqlColumnType(match[2], match[1]);
  });
  const titleCount = properties.filter((property) => property.type === "title").length;
  const uniqueIdCount = properties.filter((property) => property.type === "unique_id").length;
  if (titleCount > 1) throw new Error("A database can have only one title property.");
  if (uniqueIdCount > 1) throw new Error("A database can have only one unique_id property.");
  return properties;
}

export function notionTypedDatabaseProperties(databaseType) {
  if (databaseType === "tasks") {
    return [
      { name: "Task name", type: "title" },
      { name: "Status", type: "status", options: [
        { name: "Not started", color: "default" }, { name: "In progress", color: "blue" }, { name: "Done", color: "green" },
      ] },
      { name: "Assignee", type: "person" },
      { name: "Due", type: "date" },
      { name: "Priority", type: "select", options: [
        { name: "High", color: "red" }, { name: "Medium", color: "yellow" }, { name: "Low", color: "blue" },
      ] },
    ];
  }
  if (databaseType === "projects") {
    return [
      { name: "Project name", type: "title" },
      { name: "Status", type: "status", options: [
        { name: "Planning", color: "default" }, { name: "In progress", color: "blue" }, { name: "Complete", color: "green" },
      ] },
      { name: "Owner", type: "person" },
      { name: "Start date", type: "date" },
      { name: "Target date", type: "date" },
    ];
  }
  if (databaseType === "skills") {
    return [
      { name: "Skill name", type: "title" },
      { name: "Description", type: "rich_text" },
      { name: "Category", type: "select", options: [] },
      { name: "Level", type: "select", options: [
        { name: "Beginner", color: "green" }, { name: "Intermediate", color: "yellow" }, { name: "Advanced", color: "red" },
      ] },
    ];
  }
  throw new Error("database_type must be tasks, projects, or skills.");
}

export function parseNotionDdlStatements(statements) {
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

export function validateNotionDdlOperations(properties, operations) {
  const simulated = properties.map((property) => ({ ...property, config: { ...(property.config ?? {}) } }));
  const find = (name) => simulated.find((property) => property.name.toLowerCase() === String(name).toLowerCase());
  for (const operation of operations) {
    if (operation.action === "add") {
      if (operation.property.type === "title") throw new Error("Cannot add a second title property.");
      if (find(operation.property.name)) throw new Error(`Property "${operation.property.name}" already exists.`);
      simulated.push({ id: `pending-${simulated.length}`, databaseId: properties[0]?.databaseId, ...operation.property, config: {} });
      continue;
    }
    if (operation.action === "drop") {
      const property = find(operation.name);
      if (!property) throw new Error(`Property "${operation.name}" not found.`);
      if (property.type === "title") throw new Error("Cannot delete the title property.");
      simulated.splice(simulated.indexOf(property), 1);
      continue;
    }
    if (operation.action === "rename") {
      const property = find(operation.from);
      if (!property) throw new Error(`Property "${operation.from}" not found.`);
      const duplicate = find(operation.to);
      if (duplicate && duplicate !== property) throw new Error(`Property "${operation.to}" already exists.`);
      property.name = operation.to;
      continue;
    }
    const property = find(operation.name);
    if (!property) throw new Error(`Property "${operation.name}" not found.`);
    if (property.type === "title" || operation.property.type === "title") throw new Error("Cannot alter title property type.");
    property.type = operation.property.type;
  }
  if (simulated.filter((property) => property.type === "unique_id").length > 1) {
    throw new Error("A database can have only one unique_id property.");
  }
  return simulated;
}

export {
  applySimpleSqlWhere,
  countSqlBindParameters,
  executeNotionMcpSql,
  executeStreamableNotionMcpSqlChunk,
  notionMcpSqlStreamPlan,
  NOTION_MCP_SQL_CROSS_WINDOW_ERROR,
  NOTION_MCP_SQL_LIMITS,
  parseDataSourceSqlQuery,
  parseDataSourceSqlUnionQuery,
  selectSqlColumns,
  sqlCountProjectionAlias,
} from "../../shared/notion-mcp-sql-runtime.mjs";


export function parseNotionViewConfigDsl(configure) {
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
    match = directive.match(/^MAP\s+BY\s+(.+)$/i);
    if (match) {
      config.mapBy = parseQuotedList(match[1])[0] ?? "";
      continue;
    }
    const chart = parseNotionChartDirective(directive);
    if (chart) {
      Object.assign(config, chart);
      continue;
    }
    match = directive.match(/^FORM\s+(CLOSE|OPEN)$/i);
    if (match) {
      config.formClosed = match[1].toUpperCase() === "CLOSE";
      continue;
    }
    match = directive.match(/^FORM\s+ANONYMOUS\s+(true|false)$/i);
    if (match) {
      config.formAnonymous = match[1].toLowerCase() === "true";
      continue;
    }
    match = directive.match(/^FORM\s+PERMISSIONS\s+(none|comment_only|reader|read_and_write|editor)$/i);
    if (match) {
      config.formPermissions = match[1].toLowerCase();
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
    match = directive.match(/^FREEZE\s+COLUMNS?(?:\s+(\d+))?$/i);
    if (match) {
      config.frozenColumnIndex = Number(match[1] ?? 1);
      continue;
    }
    match = directive.match(/^FREEZE\s+COLUMNS?(?:\s+THROUGH)?\s+(.+)$/i);
    if (match) {
      config.frozenColumnThrough = parseQuotedList(match[1])[0] ?? "";
      continue;
    }
    throw new Error(`Unsupported Hanji view configure directive: ${directive}`);
  }
  return config;
}

export function normalizeNotionViewConfigureInput(configure) {
  if (typeof configure === "string") return parseNotionViewConfigDsl(configure);
  return normalizeNotionViewConfig(configure);
}

export function assertRequiredNotionViewConfigure(type, input = {}) {
  const required = {
    board: ["groupBy", 'GROUP BY "Property"'],
    calendar: ["calendarBy", 'CALENDAR BY "Property"'],
    timeline: ["timelineBy", 'TIMELINE BY "Start"'],
    map: ["mapBy", 'MAP BY "Property"'],
    chart: ["chartType", "CHART column|bar|line|donut|number"],
  }[type];
  if (!required || input?.[required[0]]) return;
  throw new Error(`${required[1]} is required when creating a ${type} view.`);
}

function notionGroupConfigurationForProperty(
  props,
  value,
  label,
  propertyIdForViewInput,
  allowedTypes
) {
  const propertyId = propertyIdForViewInput(props, value, label, allowedTypes);
  if (!propertyId) return { propertyId: undefined, configuration: null };
  const prop = props.find((item) => item.id === propertyId);
  const propertyType = notionBoardMainGroupPropertyType(prop?.type) ?? prop?.type ?? "rich_text";
  return {
    propertyId,
    configuration: {
      type: propertyType,
      property_id: propertyId,
      sort: { type: "manual" },
      ...(propertyType === "status" ? { group_by: "group" } : {}),
    },
  };
}

export function applyNotionViewPresentationConfig({
  config,
  changed,
  props,
  type,
  input,
  propertyIdForViewInput,
}) {
  config.type = type;
  let chartGroup;
  if (input.visibleProperties !== undefined) {
    const visible = new Set(config.visibleProperties ?? []);
    config.properties = props.map((prop) => ({ property_id: prop.id, visible: visible.has(prop.id) }));
  }
  if (input.groupBy !== undefined) {
    const group = notionGroupConfigurationForProperty(
      props,
      input.groupBy,
      "groupBy",
      propertyIdForViewInput,
      type === "board" ? HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES : undefined
    );
    if (type === "chart") {
      chartGroup = group;
    } else {
      if (group.propertyId) config.groupBy = group.propertyId;
      else delete config.groupBy;
      config.group_by = group.configuration;
      changed.push("groupBy");
    }
  }
  if (input.subGroupBy !== undefined) {
    if (type !== "board") throw new Error("subGroupBy can only be set on board views.");
    const subGroupBy = propertyIdForViewInput(
      props,
      input.subGroupBy,
      "subGroupBy",
      ["select", "status"]
    );
    if (subGroupBy && subGroupBy === config.groupBy) {
      throw new Error("subGroupBy must be different from groupBy.");
    }
    if (subGroupBy) config.subGroupBy = subGroupBy;
    else delete config.subGroupBy;
    config.sub_group_by = subGroupBy
      ? notionGroupConfigurationForProperty(props, subGroupBy, "subGroupBy", propertyIdForViewInput).configuration
      : null;
    changed.push("subGroupBy");
  }
  const propertyMappings = /** @type {Array<[string, string, string, string[]]>} */ ([
    ["calendarBy", "calendarBy", "date_property_id", ["date"]],
    ["timelineBy", "timelineBy", "date_property_id", ["date"]],
    ["timelineEndBy", "timelineEndBy", "end_date_property_id", ["date"]],
    ["mapBy", "mapBy", "map_by", ["place", "location"]],
  ]);
  for (const [inputKey, localKey, officialKey, allowedTypes] of propertyMappings) {
    if (input[inputKey] === undefined) continue;
    const propertyId = propertyIdForViewInput(props, input[inputKey], inputKey, allowedTypes);
    if (propertyId) config[localKey] = propertyId;
    else delete config[localKey];
    config[officialKey] = propertyId ?? null;
    changed.push(localKey);
  }
  if (input.coverProperty !== undefined) {
    const raw = String(input.coverProperty).trim();
    if (!raw || raw === "__page_cover" || raw.toLowerCase() === "page") config.coverProperty = undefined;
    else if (raw === "__none" || raw.toLowerCase() === "none") config.coverProperty = "__none";
    else config.coverProperty = propertyIdForViewInput(props, raw, "coverProperty", ["files", "url"]);
    config.cover = config.coverProperty === "__none"
      ? null
      : config.coverProperty
        ? { type: "property", property_id: config.coverProperty }
        : { type: "page_cover" };
    changed.push("coverProperty");
  }
  if (input.wrap !== undefined) {
    config.wrap = input.wrap;
    config.wrap_cells = input.wrap;
    changed.push("wrap");
  }
  if (input.frozenColumnIndex !== undefined || input.frozenColumnThrough !== undefined) {
    let frozenColumnIndex = Number(input.frozenColumnIndex);
    if (input.frozenColumnThrough !== undefined) {
      const propertyId = propertyIdForViewInput(
        props,
        input.frozenColumnThrough,
        "frozenColumnThrough"
      );
      const order = Array.isArray(config.propertyOrder) ? config.propertyOrder : props.map((prop) => prop.id);
      const index = order.indexOf(propertyId);
      if (index < 0) {
        throw new Error(`frozenColumnThrough property "${input.frozenColumnThrough}" is not in this view.`);
      }
      frozenColumnIndex = index + 1;
    }
    if (!Number.isInteger(frozenColumnIndex) || frozenColumnIndex < 0) {
      throw new Error("frozenColumnIndex must be a non-negative integer.");
    }
    config.frozenColumnIndex = frozenColumnIndex;
    config.frozen_column_index = frozenColumnIndex;
    changed.push("frozenColumnIndex");
  }
  const hasChartInput = [
    "chartType",
    "chartGroupBy",
    "chartAggregate",
    "chartAggregateBy",
    "chartStackBy",
    "chartColor",
    "chartHeight",
    "chartSort",
    "chartCaption",
  ].some((key) => input[key] !== undefined);
  if (hasChartInput && type !== "chart") throw new Error("CHART configuration can only be set on chart views.");
  if (input.chartType !== undefined) {
    config.chart_type = input.chartType;
    const localType = {
      column: "bar",
      bar: "horizontal_bar",
      line: "line",
      donut: "donut",
    }[input.chartType];
    if (localType) config.chartType = localType;
    else delete config.chartType;
    changed.push("chartType");
  }
  if (input.chartGroupBy !== undefined) {
    chartGroup = notionGroupConfigurationForProperty(
      props,
      input.chartGroupBy,
      "chartGroupBy",
      propertyIdForViewInput
    );
  }
  if (chartGroup) {
    if (chartGroup.propertyId) config.chartGroupBy = chartGroup.propertyId;
    else delete config.chartGroupBy;
    config.x_axis = chartGroup.configuration;
    changed.push("chartGroupBy");
  }
  if (input.chartAggregate !== undefined || input.chartAggregateBy !== undefined) {
    const targetKey = (input.chartType ?? config.chart_type) === "number" ? "value" : "y_axis";
    const fallbackKey = targetKey === "value" ? "y_axis" : "value";
    const previousAggregation = [config[targetKey], config[fallbackKey]]
      .find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
    const aggregate = normalizeNotionChartAggregate(input.chartAggregate
      ?? previousAggregation?.aggregator
      ?? config.chartAggregate
      ?? "count");
    if (!aggregate) throw new Error("Unsupported CHART AGGREGATE value.");
    let propertyId;
    if (input.chartAggregateBy !== undefined) {
      if (aggregate === "count") throw new Error(NOTION_COUNT_BY_GUIDANCE);
      propertyId = propertyIdForViewInput(props, input.chartAggregateBy, "chartAggregateBy");
    } else if (!(input.chartAggregate !== undefined && aggregate === "count")) {
      const previousProperty = previousAggregation?.property_id ?? config.chartAggregateBy;
      if (previousProperty !== undefined) {
        propertyId = propertyIdForViewInput(props, previousProperty, "chartAggregateBy");
      }
    }
    if (aggregate !== "count" && !propertyId) {
      throw new Error(`chartAggregate ${aggregate} requires chartAggregateBy.`);
    }
    const aggregateProperty = propertyId
      ? props.find((property) => property.id === propertyId)
      : undefined;
    if (aggregateProperty && !notionChartAggregateSupportsProperty(aggregate, aggregateProperty.type)) {
      throw new Error(
        `CHART AGGREGATE ${aggregate} does not support ${aggregateProperty.type} property "${aggregateProperty.name}".`,
      );
    }
    const aggregation = { aggregator: aggregate, ...(propertyId ? { property_id: propertyId } : {}) };
    config[targetKey] = aggregation;
    config.chartAggregate = aggregate;
    if (aggregate !== "count" && propertyId) config.chartAggregateBy = propertyId;
    else delete config.chartAggregateBy;
    changed.push("chartAggregate");
  }
  if (input.chartStackBy !== undefined) {
    config.stack_by = notionGroupConfigurationForProperty(
      props,
      input.chartStackBy,
      "chartStackBy",
      propertyIdForViewInput
    ).configuration;
    changed.push("chartStackBy");
  }
  for (const [inputKey, configKey] of [
    ["chartColor", "color_theme"],
    ["chartHeight", "height"],
    ["chartSort", "sort"],
    ["chartCaption", "caption"],
  ]) {
    if (input[inputKey] === undefined) continue;
    config[configKey] = input[inputKey];
    changed.push(inputKey);
  }
  const hasFormInput = ["formClosed", "formAnonymous", "formPermissions"].some(
    (key) => input[key] !== undefined
  );
  if (hasFormInput && type !== "form") throw new Error("FORM configuration can only be set on form views.");
  for (const [inputKey, configKey] of [
    ["formClosed", "is_form_closed"],
    ["formAnonymous", "anonymous_submissions"],
    ["formPermissions", "submission_permissions"],
  ]) {
    if (input[inputKey] === undefined) continue;
    config[configKey] = input[inputKey];
    changed.push(inputKey);
  }
}

function notionViewProperty(props, key) {
  const raw = String(key ?? "").trim();
  const needle = raw.toLowerCase();
  return props.find((property) => property.id === raw || property.name.trim().toLowerCase() === needle);
}

function notionFilterType(type) {
  if (type === "title") return "title";
  if (type === "number" || type === "unique_id") return "number";
  if (type === "checkbox") return "checkbox";
  if (["select", "status", "multi_select", "date", "relation", "files"].includes(type)) return type;
  if (["person", "created_by", "last_edited_by"].includes(type)) return "people";
  return "rich_text";
}

function notionFilterValue(property, value) {
  if (!["select", "status", "multi_select"].includes(property.type)) return value;
  const option = (property.config?.options ?? []).find(
    (candidate) => candidate?.id === value || String(candidate?.name ?? "").toLowerCase() === String(value ?? "").toLowerCase()
  );
  return option?.name ?? value;
}

function notionFilterGroup(props, group) {
  if (!group || typeof group !== "object") return null;
  const terms = [];
  for (const filter of group.filters ?? []) {
    const property = notionViewProperty(props, filter.propertyId ?? filter.property);
    if (!property) continue;
    const operator = filter.operator ?? "equals";
    const noValue = operator === "is_empty" || operator === "is_not_empty";
    terms.push({
      property: property.id,
      [notionFilterType(property.type)]: {
        [operator]: noValue ? true : notionFilterValue(property, filter.value),
      },
    });
  }
  for (const child of group.groups ?? []) {
    const nested = notionFilterGroup(props, child);
    if (nested) terms.push(nested);
  }
  if (terms.length === 0) return null;
  if (terms.length === 1) return terms[0];
  return { [group.conjunction === "or" ? "or" : "and"]: terms };
}

const notionPresentationInputKeys = [
  "visibleProperties", "hiddenProperties", "groupBy", "clearGroupBy", "subGroupBy",
  "calendarBy", "timelineBy", "timelineEndBy", "mapBy", "coverProperty", "wrap",
  "frozenColumnIndex", "frozenColumnThrough", "chartType", "chartGroupBy",
  "chartAggregate", "chartAggregateBy", "chartStackBy", "chartColor", "chartHeight",
  "chartSort", "chartCaption", "formClosed", "formAnonymous", "formPermissions",
];
const notionPresentationConfigKeys = [
  "properties", "group_by", "sub_group_by", "date_property_id", "end_date_property_id",
  "map_by", "cover", "wrap_cells", "frozen_column_index", "x_axis", "chart_type",
  "y_axis", "value", "stack_by", "color_theme", "height", "sort", "caption",
  "is_form_closed", "anonymous_submissions", "submission_permissions",
];

export function applyNotionViewCompatMetadata({ config, base, props, type, input }) {
  const previous = base?.__notionCompat && typeof base.__notionCompat === "object"
    ? base.__notionCompat
    : null;
  const metadata = { ...(previous ?? {}) };
  if (!previous) {
    metadata.filter = null;
    metadata.sorts = null;
    metadata.quick_filters = null;
    metadata.configuration = type === "dashboard" ? { type, rows: [] } : null;
  }
  if (input.filters !== undefined || input.filterGroup !== undefined || input.filterConjunction !== undefined) {
    metadata.filter = notionFilterGroup(props, config.filterGroup);
  }
  if (input.sorts !== undefined) {
    metadata.sorts = (config.sorts ?? []).map((sort) => ({
      property: notionViewProperty(props, sort.propertyId)?.name ?? sort.propertyId,
      direction: sort.direction === "desc" ? "descending" : "ascending",
    }));
    if (metadata.sorts.length === 0) metadata.sorts = null;
  }
  const presentationChanged = notionPresentationInputKeys.some((key) => input[key] !== undefined);
  const storedPresentation = notionPresentationConfigKeys.some((key) => Object.hasOwn(config, key));
  if (presentationChanged || (!previous && storedPresentation)) {
    const configuration = metadata.configuration && typeof metadata.configuration === "object"
      ? { ...metadata.configuration, type }
      : { type };
    for (const key of notionPresentationConfigKeys) {
      if (Object.hasOwn(config, key)) configuration[key] = config[key];
    }
    metadata.configuration = configuration;
  }
  config.__notionCompat = metadata;
}
