// Current Notion chart aggregate capability matrix shared by Hanji's hosted
// planner, stdio planner, and browser renderer. Keep this file dependency-free
// so Node and Vite consume the exact same values without a build step.

const NUMBER_PROPERTY_TYPES = Object.freeze(["number", "formula", "rollup"]);
const CHECKBOX_PROPERTY_TYPES = Object.freeze(["checkbox"]);
const DATE_PROPERTY_TYPES = Object.freeze(["date", "created_time", "last_edited_time"]);

export const NOTION_CHART_AGGREGATE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "count", family: "count", propertyTypes: null }),
  Object.freeze({ id: "count_values", family: "presence", propertyTypes: "any" }),
  Object.freeze({ id: "sum", family: "number", propertyTypes: NUMBER_PROPERTY_TYPES }),
  Object.freeze({ id: "average", family: "number", propertyTypes: NUMBER_PROPERTY_TYPES }),
  Object.freeze({ id: "median", family: "number", propertyTypes: NUMBER_PROPERTY_TYPES }),
  Object.freeze({ id: "min", family: "number", propertyTypes: NUMBER_PROPERTY_TYPES }),
  Object.freeze({ id: "max", family: "number", propertyTypes: NUMBER_PROPERTY_TYPES }),
  Object.freeze({ id: "range", family: "number", propertyTypes: NUMBER_PROPERTY_TYPES }),
  Object.freeze({ id: "unique", family: "presence", propertyTypes: "any" }),
  Object.freeze({ id: "empty", family: "presence", propertyTypes: "any" }),
  Object.freeze({ id: "not_empty", family: "presence", propertyTypes: "any" }),
  Object.freeze({ id: "percent_empty", family: "percent", propertyTypes: "any" }),
  Object.freeze({ id: "percent_not_empty", family: "percent", propertyTypes: "any" }),
  Object.freeze({ id: "checked", family: "checkbox", propertyTypes: CHECKBOX_PROPERTY_TYPES }),
  Object.freeze({ id: "unchecked", family: "checkbox", propertyTypes: CHECKBOX_PROPERTY_TYPES }),
  Object.freeze({ id: "percent_checked", family: "percent_checkbox", propertyTypes: CHECKBOX_PROPERTY_TYPES }),
  Object.freeze({ id: "percent_unchecked", family: "percent_checkbox", propertyTypes: CHECKBOX_PROPERTY_TYPES }),
  Object.freeze({ id: "earliest_date", family: "date", propertyTypes: DATE_PROPERTY_TYPES }),
  Object.freeze({ id: "latest_date", family: "date", propertyTypes: DATE_PROPERTY_TYPES }),
  Object.freeze({ id: "date_range", family: "date_range", propertyTypes: DATE_PROPERTY_TYPES }),
]);

export const NOTION_CHART_AGGREGATES = Object.freeze(
  NOTION_CHART_AGGREGATE_DEFINITIONS.map((definition) => definition.id),
);

const DEFINITIONS_BY_ID = new Map(
  NOTION_CHART_AGGREGATE_DEFINITIONS.map((definition) => [definition.id, definition]),
);

const AGGREGATE_ALIASES = Object.freeze({
  count_all: "count",
  show_count: "count",
  count_unique: "unique",
  count_unique_values: "unique",
  count_empty: "empty",
  count_not_empty: "not_empty",
  total: "sum",
  avg: "average",
  mean: "average",
  minimum: "min",
  maximum: "max",
});

export function normalizeNotionChartAggregate(value) {
  if (typeof value !== "string") return undefined;
  const token = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const canonical = AGGREGATE_ALIASES[token] ?? token;
  return DEFINITIONS_BY_ID.has(canonical) ? canonical : undefined;
}

export function notionChartAggregateDefinition(value) {
  const canonical = normalizeNotionChartAggregate(value);
  return canonical ? DEFINITIONS_BY_ID.get(canonical) : undefined;
}

export function notionChartAggregateRequiresProperty(value) {
  const definition = notionChartAggregateDefinition(value);
  return !!definition && definition.propertyTypes !== null;
}

export function notionChartAggregateSupportsProperty(value, propertyType) {
  const definition = notionChartAggregateDefinition(value);
  if (!definition) return false;
  if (definition.propertyTypes === null) return propertyType == null;
  if (typeof propertyType !== "string" || !propertyType) return false;
  return definition.propertyTypes === "any" || definition.propertyTypes.includes(propertyType);
}

export function notionChartAggregateFamily(value) {
  return notionChartAggregateDefinition(value)?.family;
}
