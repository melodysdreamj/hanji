export function stripHanjiId(value) {
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

export function parseNotionCreateTableSchema(schema) {
  const body = String(schema ?? "").match(/CREATE\s+TABLE(?:\s+[^(]+)?\s*\((.*)\)\s*$/is)?.[1];
  if (!body) throw new Error("schema must be a CREATE TABLE (...) statement.");
  return splitTopLevel(body).map((column) => {
    const match = column.match(/^\s*"([^"]+)"\s+(.+)$/s) ?? column.match(/^\s*'([^']+)'\s+(.+)$/s);
    if (!match) throw new Error(`Could not parse schema column: ${column}`);
    return parseNotionSqlColumnType(match[2], match[1]);
  });
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

export function applySimpleSqlWhere(rows, whereClause, params = []) {
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

export function selectSqlColumns(rows, select) {
  const trimmed = String(select ?? "*").trim();
  if (trimmed === "*") return rows;
  if (/^COUNT\s*\(\s*\*\s*\)$/i.test(trimmed)) return [{ count: rows.length }];
  const columns = parseQuotedList(trimmed);
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
}


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

export function normalizeNotionViewConfigureInput(configure) {
  if (typeof configure === "string") return parseNotionViewConfigDsl(configure);
  return normalizeNotionViewConfig(configure);
}
