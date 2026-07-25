export type NotionChartAggregate =
  | "count"
  | "count_values"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "unique"
  | "empty"
  | "not_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "percent_unchecked"
  | "earliest_date"
  | "latest_date"
  | "date_range";

export type NotionChartAggregateFamily =
  | "count"
  | "presence"
  | "number"
  | "percent"
  | "checkbox"
  | "percent_checkbox"
  | "date"
  | "date_range";

export interface NotionChartAggregateDefinition {
  readonly id: NotionChartAggregate;
  readonly family: NotionChartAggregateFamily;
  readonly propertyTypes: null | "any" | readonly string[];
}

export const NOTION_CHART_AGGREGATE_DEFINITIONS: readonly NotionChartAggregateDefinition[];
export const NOTION_CHART_AGGREGATES: readonly NotionChartAggregate[];

export function normalizeNotionChartAggregate(value: unknown): NotionChartAggregate | undefined;
export function notionChartAggregateDefinition(value: unknown): NotionChartAggregateDefinition | undefined;
export function notionChartAggregateRequiresProperty(value: unknown): boolean;
export function notionChartAggregateSupportsProperty(value: unknown, propertyType?: string | null): boolean;
export function notionChartAggregateFamily(value: unknown): NotionChartAggregateFamily | undefined;
