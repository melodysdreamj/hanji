import { eb } from "./edgebase.mjs";
import {
  compactNumber,
  evaluateFormulaExpression,
  formulaDate,
  formulaDateKeyFromDate,
  formatFormulaValue,
} from "./formula-runtime.mjs";

const titleOf = (page) =>
  (page.iconType === "emoji" && page.icon ? page.icon + " " : "") +
  (page.title || "Untitled");

function optionName(prop, id) {
  const option = (prop.config?.options ?? []).find((item) => String(item.id) === String(id));
  return option?.name ?? String(id ?? "");
}

export function optionId(prop, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const option = (prop.config?.options ?? []).find(
    (item) => String(item.id) === raw || item.name.toLowerCase() === raw.toLowerCase()
  );
  return option?.id ?? raw;
}

export function ids(value) {
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

export function personIds(value) {
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


export function propValue(row, prop) {
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

export function databasePropsContext(pages, databaseId, props) {
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
    return evaluateFormulaExpression(expression, (name) => {
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
  } catch {
    return "";
  }
}

export function formatDbValue(row, prop, pagesById = {}, props = [], propsByDb = {}) {
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

export function compareViewSortKeys(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function viewDisplayProperties(props, view) {
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

export function applyDatabaseView(rows, props, pagesById, view, search, propsByDb = {}) {
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
