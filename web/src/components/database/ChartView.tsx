"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  NOTION_CHART_AGGREGATES,
  normalizeNotionChartAggregate,
  notionChartAggregateFamily,
  notionChartAggregateRequiresProperty,
  notionChartAggregateSupportsProperty,
} from "../../../../shared/notion-chart-aggregates.mjs";
import type { NotionChartAggregate } from "../../../../shared/notion-chart-aggregates.mjs";
import { activeDateLocale, isKoreanLocale } from "@/lib/i18n";
import { i18next } from "@/i18n";
import type { DbProperty, DbView, Page, ViewConfig } from "@/lib/types";
import { useStore } from "@/lib/store";
import { applyView, cellValue } from "./query";
import { dateKey, extractEnd, formatDate, parseDate } from "./dateUtils";
import { normalizePersonIds, personLabel } from "./people";
import { formatNumberValue, numberFormatForProperty } from "./numberFormat";
import { nextColor } from "./colors";
import { NotionSelect } from "./NotionSelect";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import {
  effectiveSummaryValue,
  summaryValuePieces,
  summaryValuePresent,
} from "./summaryValue";
import styles from "./database.module.css";
import chartStyles from "./chartView.module.css";

export type ChartType = "bar" | "horizontal_bar" | "line" | "donut";
export type ChartAggregate = NotionChartAggregate;

const CHART_TYPES: ChartType[] = ["bar", "horizontal_bar", "line", "donut"];
const CHART_AGGREGATES: ChartAggregate[] = [...NOTION_CHART_AGGREGATES];
const EMPTY_BUCKET_KEY = "__empty";

const CHART_NS = "chartView";

// User-facing copy for this surface lives in the i18next catalogs at
// web/src/locales/<lang>/chartView.json. `tt` is an i18next-backed accessor so
// module-scope helpers (chartBuckets, DonutChart, …) resolve translations at
// call time; the ChartView component reads the same catalog through the
// useTranslation hook so it re-renders on language change.
function tt(key: string, options?: Record<string, unknown>): string {
  return i18next.t(`${CHART_NS}:${key}`, options) as string;
}

/**
 * Localized month bucket label. Korean uses the catalog's year/month template;
 * every other locale is formatted through Intl so month names follow the active
 * date locale rather than a hardcoded string.
 */
function formatMonthLabel(year: number, month: number): string {
  if (isKoreanLocale()) return tt("monthLabel", { year, month });
  return new Date(year, month - 1, 1).toLocaleDateString(activeDateLocale(), {
    month: "short",
    year: "numeric",
  });
}

const CHART_GROUPABLE_TYPES = new Set<DbProperty["type"]>([
  "select",
  "multi_select",
  "status",
  "checkbox",
  "person",
  "date",
  "created_time",
  "last_edited_time",
]);

// Series fills use the solid --c-* tokens — the saturated counterparts of the
// chip background tokens in colors.ts. Both palettes flip with
// [data-theme="dark"], so charts stay on-palette in either theme.
const SERIES_COLOR: Record<string, string> = {
  default: "var(--c-gray)",
  gray: "var(--c-gray)",
  brown: "var(--c-brown)",
  orange: "var(--c-orange)",
  yellow: "var(--c-yellow)",
  green: "var(--c-green)",
  blue: "var(--c-blue)",
  purple: "var(--c-purple)",
  pink: "var(--c-pink)",
  red: "var(--c-red)",
};

function seriesColor(color?: string) {
  return SERIES_COLOR[color ?? "gray"] ?? SERIES_COLOR.gray;
}

interface ChartBucket {
  key: string;
  label: string;
  color: string;
  rows: Page[];
}

interface ChartSeriesEntry extends ChartBucket {
  value: number;
  formatted: string;
}

function normalizedChartType(value: unknown): ChartType | undefined {
  return CHART_TYPES.includes(value as ChartType) ? (value as ChartType) : undefined;
}

function normalizedChartAggregate(value: unknown): ChartAggregate | undefined {
  return normalizeNotionChartAggregate(value);
}

export function isChartGroupableProperty(prop: DbProperty) {
  return CHART_GROUPABLE_TYPES.has(prop.type);
}

function appendEmptyBucket(buckets: ChartBucket[], rows: Page[]): ChartBucket[] {
  if (rows.length === 0) return buckets;
  return [...buckets, { key: EMPTY_BUCKET_KEY, label: tt("empty"), color: "default", rows }];
}

/** Enumerate the YYYY-MM keys from `start` through `end` inclusive. */
function monthKeysBetween(start: string, end: string): string[] {
  const keys: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const endYear = Number(end.slice(0, 4));
  const endMonth = Number(end.slice(5, 7));
  // Guard against malformed keys so we never loop unbounded.
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(endYear) || !Number.isFinite(endMonth)) {
    return [start];
  }
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    if (keys.length > 1200) break; // ~100 years hard stop
  }
  return keys;
}

/**
 * Group the (already filtered/sorted) rows into chart buckets for `prop`.
 * `fillDateGaps` (line charts) inserts empty buckets for months with no rows so
 * a continuous time axis isn't misrepresented by connecting across a gap.
 */
export function chartBuckets(
  rows: Page[],
  prop: DbProperty,
  fillDateGaps = false
): ChartBucket[] {
  if (prop.type === "checkbox") {
    return [
      { key: "checked", label: tt("checked"), color: "green", rows: rows.filter((row) => !!cellValue(row, prop)) },
      { key: "unchecked", label: tt("unchecked"), color: "gray", rows: rows.filter((row) => !cellValue(row, prop)) },
    ];
  }

  if (prop.type === "person") {
    const byPerson = new Map<string, Page[]>();
    const empty: Page[] = [];
    for (const row of rows) {
      const ids = normalizePersonIds(cellValue(row, prop));
      if (ids.length === 0) {
        empty.push(row);
        continue;
      }
      for (const id of ids) byPerson.set(id, [...(byPerson.get(id) ?? []), row]);
    }
    const buckets = Array.from(byPerson.entries()).map(([id, bucketRows], index) => ({
      key: id,
      label: personLabel(id),
      color: nextColor(index) as string,
      rows: bucketRows,
    }));
    return appendEmptyBucket(buckets, empty);
  }

  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
    const byMonth = new Map<string, Page[]>();
    const empty: Page[] = [];
    for (const row of rows) {
      const key = dateKey(cellValue(row, prop)).slice(0, 7);
      if (!key) {
        empty.push(row);
        continue;
      }
      byMonth.set(key, [...(byMonth.get(key) ?? []), row]);
    }
    const presentKeys = Array.from(byMonth.keys()).sort();
    // For a continuous time axis (line charts), materialize every month between
    // the first and last so gaps render as gaps, not a straight line drawn
    // across skipped months. Bar/donut keep only the months that have rows.
    const monthKeys =
      fillDateGaps && presentKeys.length > 1
        ? monthKeysBetween(presentKeys[0], presentKeys[presentKeys.length - 1])
        : presentKeys;
    const buckets = monthKeys.map((key, index) => ({
      key,
      label: formatMonthLabel(Number(key.slice(0, 4)), Number(key.slice(5, 7))),
      color: nextColor(index) as string,
      rows: byMonth.get(key) ?? [],
    }));
    return appendEmptyBucket(buckets, empty);
  }

  // select / status / multi_select: one bucket per option, in option order.
  // multi_select rows count toward every selected option's bucket.
  const options = prop.config?.options ?? [];
  const known = new Set(options.map((option) => option.id));
  const byOption = new Map<string, Page[]>();
  const empty: Page[] = [];
  for (const row of rows) {
    const raw = cellValue(row, prop);
    const ids = (Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw])
      .map(String)
      .filter((id) => known.has(id));
    if (ids.length === 0) {
      empty.push(row);
      continue;
    }
    for (const id of prop.type === "multi_select" ? ids : ids.slice(0, 1)) {
      byOption.set(id, [...(byOption.get(id) ?? []), row]);
    }
  }
  const buckets = options.map((option) => ({
    key: option.id,
    label: option.name,
    color: option.color,
    rows: byOption.get(option.id) ?? [],
  }));
  return appendEmptyBucket(buckets, empty);
}

function aggregateRawValue(
  row: Page,
  prop: DbProperty,
  props: DbProperty[],
  pagesById: Record<string, Page>
) {
  return effectiveSummaryValue(row, prop, props, pagesById);
}

function numericAggregateValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function aggregateDateValues(value: unknown): Date[] {
  const values = [parseDate(value), parseDate(extractEnd(value))]
    .filter((date): date is Date => !!date);
  return values.sort((left, right) => left.getTime() - right.getTime());
}

export function aggregateChartValue(
  rows: Page[],
  aggregate: ChartAggregate,
  prop?: DbProperty,
  pagesById: Record<string, Page> = {},
  props: DbProperty[] = []
): number | null {
  if (aggregate === "count") return rows.length;
  if (!prop || !notionChartAggregateSupportsProperty(aggregate, prop.type)) return null;

  const values = rows.map((row) => aggregateRawValue(row, prop, props, pagesById));
  const present = values.filter((value) => summaryValuePresent(value, prop, pagesById));

  if (aggregate === "count_values") return present.length;
  if (aggregate === "unique") {
    return new Set(values.flatMap((value) => summaryValuePieces(value, prop, pagesById))).size;
  }
  if (aggregate === "empty") return rows.length - present.length;
  if (aggregate === "not_empty") return present.length;
  if (aggregate === "percent_empty") {
    return rows.length ? ((rows.length - present.length) / rows.length) * 100 : 0;
  }
  if (aggregate === "percent_not_empty") {
    return rows.length ? (present.length / rows.length) * 100 : 0;
  }

  const checked = values.filter((value) => value === true).length;
  if (aggregate === "checked") return checked;
  if (aggregate === "unchecked") return rows.length - checked;
  if (aggregate === "percent_checked") return rows.length ? (checked / rows.length) * 100 : 0;
  if (aggregate === "percent_unchecked") {
    return rows.length ? ((rows.length - checked) / rows.length) * 100 : 0;
  }

  const numbers = values
    .map(numericAggregateValue)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (aggregate === "sum") return numbers.reduce((sum, value) => sum + value, 0);
  if (aggregate === "average") {
    return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
  }
  if (aggregate === "median") {
    if (!numbers.length) return null;
    const middle = Math.floor(numbers.length / 2);
    return numbers.length % 2
      ? numbers[middle]
      : (numbers[middle - 1] + numbers[middle]) / 2;
  }
  if (aggregate === "min") return numbers.length ? numbers[0] : null;
  if (aggregate === "max") return numbers.length ? numbers[numbers.length - 1] : null;
  if (aggregate === "range") {
    return numbers.length ? numbers[numbers.length - 1] - numbers[0] : null;
  }

  const dates = values
    .flatMap(aggregateDateValues)
    .sort((left, right) => left.getTime() - right.getTime());
  if (!dates.length) return null;
  if (aggregate === "earliest_date") return dates[0].getTime();
  if (aggregate === "latest_date") return dates[dates.length - 1].getTime();
  if (aggregate === "date_range") {
    return Math.round((dates[dates.length - 1].getTime() - dates[0].getTime()) / 86_400_000);
  }
  return null;
}

// ── imported Notion chart config recovery ───────────────────────────────
// Imported chart views carry the raw Notion view record in config.notion.
// The exact shape is not contractual, so this is a tolerant best-effort scan:
// recognizable chart-type / axis / aggregation hints are mapped onto the
// local chart config, and anything unrecognized falls back to the defaults.

export interface RecoveredNotionChartConfig {
  chartType?: ChartType;
  groupById?: string;
  aggregate?: ChartAggregate;
  aggregateById?: string;
}

const NOTION_CHART_TYPE_TOKENS: Record<string, ChartType> = {
  bar: "bar",
  bar_chart: "bar",
  column: "bar",
  column_chart: "bar",
  vertical_bar: "bar",
  horizontal: "horizontal_bar",
  horizontal_bar: "horizontal_bar",
  horizontal_bar_chart: "horizontal_bar",
  row_chart: "horizontal_bar",
  line: "line",
  line_chart: "line",
  area: "line",
  area_chart: "line",
  donut: "donut",
  donut_chart: "donut",
  doughnut: "donut",
  pie: "donut",
  pie_chart: "donut",
  ring: "donut",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
}

function normalizedScanKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

function notionPropertyRef(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record || depth > 2) return undefined;
  for (const key of ["property", "property_id", "propertyId", "id", "name", "property_name", "propertyName"]) {
    const ref = notionPropertyRef(record[key], depth + 1);
    if (ref) return ref;
  }
  return undefined;
}

interface NotionChartScan {
  chartType?: ChartType;
  aggregate?: ChartAggregate;
  groupByRef?: string;
  aggregateByRef?: string;
}

function scanNotionChartRecord(value: unknown, inChart: boolean, out: NotionChartScan, depth = 0) {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) scanNotionChartRecord(item, inChart, out, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [rawKey, entry] of Object.entries(record)) {
    const key = normalizedScanKey(rawKey);
    const chartish = inChart || key.includes("chart");
    if (
      !out.chartType &&
      (key === "charttype" || (chartish && (key === "type" || key === "kind" || key === "variant" || key === "layout")))
    ) {
      out.chartType = NOTION_CHART_TYPE_TOKENS[normalizedToken(entry)];
    }
    if (!out.aggregate && key.startsWith("aggregat")) {
      out.aggregate = normalizeNotionChartAggregate(normalizedToken(entry));
    }
    if (
      !out.groupByRef &&
      (key === "xaxis" || key === "xaxisproperty" || key === "xproperty" || key === "groupby" || key === "groupbyproperty" || key === "groupproperty")
    ) {
      out.groupByRef = notionPropertyRef(entry);
    }
    if (
      !out.aggregateByRef &&
      (key === "yaxis" || key === "yaxisproperty" || key === "yproperty" || key === "valueproperty" || key === "aggregateby")
    ) {
      out.aggregateByRef = notionPropertyRef(entry);
    }
    scanNotionChartRecord(entry, chartish, out, depth + 1);
  }
}

function localPropertyForNotionRef(props: DbProperty[], ref?: string) {
  if (!ref) return undefined;
  let decoded: string | undefined;
  try {
    const value = decodeURIComponent(ref);
    decoded = value !== ref ? value : undefined;
  } catch {
    decoded = undefined;
  }
  return props.find(
    (prop) =>
      prop.id === ref ||
      prop.config?.notionPropertyId === ref ||
      prop.name === ref ||
      (decoded !== undefined && (prop.config?.notionPropertyId === decoded || prop.name === decoded))
  );
}

export function recoveredNotionChartConfig(view: DbView, props: DbProperty[]): RecoveredNotionChartConfig {
  const raw = asRecord(view.config?.notion);
  const notionType = view.config?.notionType ?? (typeof raw?.type === "string" ? raw.type : undefined);
  if (view.type !== "chart" && notionType !== "chart") return {};
  const scan: NotionChartScan = {};
  scanNotionChartRecord(view.config, true, scan);
  const groupProp = localPropertyForNotionRef(props, scan.groupByRef);
  const aggregateProp = localPropertyForNotionRef(props, scan.aggregateByRef);
  return {
    chartType: scan.chartType,
    aggregate: scan.aggregate,
    groupById: groupProp && isChartGroupableProperty(groupProp) ? groupProp.id : undefined,
    aggregateById:
      aggregateProp && notionChartAggregateSupportsProperty(scan.aggregate, aggregateProp.type)
        ? aggregateProp.id
        : undefined,
  };
}

// ── SVG rendering ────────────────────────────────────────────────────────

function truncatedLabel(label: string) {
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

function niceStep(rough: number) {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function valueTicks(values: number[], includeZero = true): number[] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 1];
  let min = includeZero ? Math.min(0, ...finite) : Math.min(...finite);
  let max = includeZero ? Math.max(0, ...finite) : Math.max(...finite);
  if (min === max) max = min + 1;
  const step = niceStep((max - min) / 4);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  if (!includeZero && min >= Math.min(...finite)) min -= step;
  const ticks: number[] = [];
  for (let tick = min; tick <= max + step / 2; tick += step) {
    ticks.push(Math.abs(tick) < step / 1e6 ? 0 : Number(tick.toFixed(6)));
  }
  return ticks;
}

function ColumnOrLineChart({
  series,
  line,
  ariaLabel,
  formatTick,
  includeZero,
}: {
  series: ChartSeriesEntry[];
  line: boolean;
  ariaLabel: string;
  formatTick: (value: number) => string;
  includeZero: boolean;
}) {
  const width = 760;
  const height = 320;
  const left = 56;
  const right = width - 16;
  const top = 16;
  const bottom = height - 40;
  const ticks = valueTicks(series.map((entry) => entry.value), includeZero);
  const min = ticks[0];
  const max = ticks[ticks.length - 1];
  const yFor = (value: number) => bottom - ((value - min) / (max - min)) * (bottom - top);
  const slot = (right - left) / Math.max(1, series.length);
  const barWidth = Math.max(6, Math.min(64, slot * 0.6));
  const labelEvery = Math.max(1, Math.ceil(series.length / 12));

  return (
    <div className={chartStyles.canvasWrap}>
      <svg
        className={chartStyles.canvas}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="xMidYMid meet"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className={tick === 0 ? chartStyles.axisLine : chartStyles.gridline}
              x1={left}
              x2={right}
              y1={yFor(tick)}
              y2={yFor(tick)}
            />
            <text className={chartStyles.tickText} x={left - 8} y={yFor(tick) + 3} textAnchor="end">
              {formatTick(tick)}
            </text>
          </g>
        ))}
        {!line &&
          series.map((entry, index) => {
            const x = left + slot * index + (slot - barWidth) / 2;
            const zero = yFor(includeZero ? 0 : min);
            const barTop = Math.min(yFor(entry.value), zero);
            const barHeight = Math.abs(yFor(entry.value) - zero);
            return (
              <rect
                key={entry.key}
                className={chartStyles.bar}
                data-chart-bar={entry.key}
                x={x}
                y={barTop}
                width={barWidth}
                height={entry.value === 0 ? 0 : Math.max(barHeight, 1)}
                rx={2}
                fill={seriesColor(entry.color)}
              >
                <title>{`${entry.label}: ${entry.formatted}`}</title>
              </rect>
            );
          })}
        {line && (
          <>
            <polyline
              className={chartStyles.line}
              points={series
                .map((entry, index) => `${left + slot * index + slot / 2},${yFor(entry.value)}`)
                .join(" ")}
            />
            {series.map((entry, index) => (
              <circle
                key={entry.key}
                className={chartStyles.point}
                data-chart-point={entry.key}
                cx={left + slot * index + slot / 2}
                cy={yFor(entry.value)}
                r={4}
              >
                <title>{`${entry.label}: ${entry.formatted}`}</title>
              </circle>
            ))}
          </>
        )}
        {series.map((entry, index) =>
          index % labelEvery === 0 ? (
            <text
              key={entry.key}
              className={chartStyles.axisText}
              x={left + slot * index + slot / 2}
              y={height - 12}
              textAnchor="middle"
            >
              {truncatedLabel(entry.label)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

function HorizontalBarChart({
  series,
  ariaLabel,
  formatTick,
  includeZero,
}: {
  series: ChartSeriesEntry[];
  ariaLabel: string;
  formatTick: (value: number) => string;
  includeZero: boolean;
}) {
  const width = 760;
  const rowHeight = 30;
  const top = 12;
  const left = 150;
  const right = width - 20;
  const height = top + Math.max(1, series.length) * rowHeight + 34;
  const ticks = valueTicks(series.map((entry) => entry.value), includeZero);
  const min = ticks[0];
  const max = ticks[ticks.length - 1];
  const xFor = (value: number) => left + ((value - min) / (max - min)) * (right - left);

  return (
    <div className={chartStyles.canvasWrap}>
      <svg
        className={chartStyles.canvas}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="xMidYMid meet"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className={tick === 0 ? chartStyles.axisLine : chartStyles.gridline}
              x1={xFor(tick)}
              x2={xFor(tick)}
              y1={top}
              y2={height - 24}
            />
            <text className={chartStyles.tickText} x={xFor(tick)} y={height - 10} textAnchor="middle">
              {formatTick(tick)}
            </text>
          </g>
        ))}
        {series.map((entry, index) => {
          const y = top + rowHeight * index + 5;
          const zero = xFor(includeZero ? 0 : min);
          const barLeft = Math.min(xFor(entry.value), zero);
          const barWidth = Math.abs(xFor(entry.value) - zero);
          return (
            <g key={entry.key}>
              <text
                className={chartStyles.axisText}
                x={left - 8}
                y={y + (rowHeight - 10) / 2 + 4}
                textAnchor="end"
              >
                {truncatedLabel(entry.label)}
              </text>
              <rect
                className={chartStyles.bar}
                data-chart-bar={entry.key}
                x={barLeft}
                y={y}
                width={entry.value === 0 ? 0 : Math.max(barWidth, 1)}
                height={rowHeight - 10}
                rx={2}
                fill={seriesColor(entry.color)}
              >
                <title>{`${entry.label}: ${entry.formatted}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function donutArcPath(cx: number, cy: number, radius: number, start: number, end: number) {
  const x1 = cx + radius * Math.cos(start);
  const y1 = cy + radius * Math.sin(start);
  const x2 = cx + radius * Math.cos(end);
  const y2 = cy + radius * Math.sin(end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
}

function DonutChart({
  series,
  ariaLabel,
  centerText,
}: {
  series: ChartSeriesEntry[];
  ariaLabel: string;
  centerText?: string;
}) {
  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 88;
  const stroke = 34;
  const positive = series.filter((entry) => entry.value > 0);
  const total = positive.reduce((sum, entry) => sum + entry.value, 0);
  const gap = positive.length > 1 ? 0.02 : 0;

  let angle = -Math.PI / 2;
  const segments = positive.map((entry) => {
    const sweep = (entry.value / total) * Math.PI * 2;
    const segment = { entry, start: angle + gap, end: angle + sweep - gap };
    angle += sweep;
    return segment;
  });

  return (
    <div className={chartStyles.donutWrap}>
      <svg
        className={chartStyles.donutCanvas}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="xMidYMid meet"
      >
        {positive.length === 0 && (
          <circle className={chartStyles.donutPlaceholder} cx={cx} cy={cy} r={radius} fill="none" strokeWidth={stroke} />
        )}
        {positive.length === 1 && (
          <circle
            className={chartStyles.donutSegment}
            data-chart-segment={positive[0].key}
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke={seriesColor(positive[0].color)}
            strokeWidth={stroke}
          >
            <title>{`${positive[0].label}: ${positive[0].formatted}`}</title>
          </circle>
        )}
        {positive.length > 1 &&
          segments.map(({ entry, start, end }) => (
            <path
              key={entry.key}
              className={chartStyles.donutSegment}
              data-chart-segment={entry.key}
              d={donutArcPath(cx, cy, radius, start, Math.max(end, start + 0.005))}
              fill="none"
              stroke={seriesColor(entry.color)}
              strokeWidth={stroke}
            >
              <title>{`${entry.label}: ${entry.formatted}`}</title>
            </path>
          ))}
        {centerText !== undefined && (
          <>
            <text className={chartStyles.donutTotal} x={cx} y={cy + 2} textAnchor="middle">
              {centerText}
            </text>
            <text className={chartStyles.donutTotalLabel} x={cx} y={cy + 22} textAnchor="middle">
              {tt("total")}
            </text>
          </>
        )}
      </svg>
      <ul className={chartStyles.legend} aria-label={tt("legend")}>
        {series.map((entry) => (
          <li key={entry.key} className={chartStyles.legendItem}>
            <span
              className={chartStyles.legendChip}
              style={{ background: seriesColor(entry.color) }}
              aria-hidden="true"
            />
            <span className={chartStyles.legendLabel}>{entry.label}</span>
            <span className={chartStyles.legendValue}>
              {entry.formatted}
              {total > 0 && entry.value > 0 ? ` · ${Math.round((entry.value / total) * 100)}%` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── view component ───────────────────────────────────────────────────────

export function ChartView({
  db,
  view,
  rows: rowsProp,
  rowsViewApplied = false,
  readOnly = false,
  search,
  contextPageId,
}: {
  db: Page;
  view: DbView;
  rows?: Page[];
  rowsViewApplied?: boolean;
  readOnly?: boolean;
  search?: string;
  contextPageId?: string;
}) {
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rows = rowsProp ?? storeRows;
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const updateView = useStore((s) => s.updateView);
  const { t } = useTranslation([CHART_NS, "common"]);

  const groupableProps = props.filter(isChartGroupableProperty);
  const recovered = recoveredNotionChartConfig(view, props);

  const chartType = normalizedChartType(view.config?.chartType) ?? recovered.chartType ?? "bar";
  const groupProp =
    groupableProps.find((prop) => prop.id === view.config?.chartGroupBy) ??
    groupableProps.find((prop) => prop.id === recovered.groupById) ??
    groupableProps.find((prop) => prop.type === "select" || prop.type === "status") ??
    groupableProps[0];
  const requestedAggregate =
    normalizedChartAggregate(view.config?.chartAggregate) ?? recovered.aggregate ?? "count";
  const aggregate: ChartAggregate = requestedAggregate;
  const aggregateByRef = view.config?.chartAggregateBy ?? recovered.aggregateById;
  const configuredAggregateBy = props.find((prop) => prop.id === aggregateByRef);
  const aggregateBy = configuredAggregateBy
    && notionChartAggregateSupportsProperty(aggregate, configuredAggregateBy.type)
    ? configuredAggregateBy
    : undefined;
  const compatibleAggregateProps = props.filter((prop) =>
    notionChartAggregateSupportsProperty(aggregate, prop.type)
  );
  const aggregateSupported = !notionChartAggregateRequiresProperty(aggregate) || !!aggregateBy;
  const aggregateFamily = notionChartAggregateFamily(aggregate);

  // Memoized like TableView's `shown`: applyView runs a full search-filter +
  // filter-group + multi-key sort over every loaded row on each render.
  const shown = useMemo(
    () =>
      rowsViewApplied
        ? rows
        : applyView(rows, props, view, pagesById, { search, currentPageId: contextPageId }),
    [rows, rowsViewApplied, props, view, pagesById, search, contextPageId]
  );
  const numberFormat = aggregateFamily === "number" && aggregateBy?.type === "number"
    ? numberFormatForProperty(aggregateBy)
    : "number";
  const formatValue = (value: number) => {
    if (aggregateFamily === "percent" || aggregateFamily === "percent_checkbox") {
      return formatNumberValue(value, "percent");
    }
    if (aggregateFamily === "date") {
      return formatDate(dateKey(new Date(value)), { year: "always" });
    }
    if (aggregateFamily === "date_range") {
      return t(`${CHART_NS}:dateRangeDays`, { count: value });
    }
    return formatNumberValue(value, numberFormat);
  };
  const includeZero = aggregateFamily !== "date";
  const buckets = groupProp ? chartBuckets(shown, groupProp, chartType === "line") : [];
  const series: ChartSeriesEntry[] = aggregateSupported ? buckets.flatMap((bucket) => {
    const value = aggregateChartValue(bucket.rows, aggregate, aggregateBy, pagesById, props);
    // null => no compatible values for this bucket: omit rather than plot a
    // false zero or silently substitute a different aggregate.
    if (value === null) return [];
    return [{ ...bucket, value, formatted: formatValue(value) }];
  }) : [];
  const ariaLabel = t(`${CHART_NS}:chartAria`, {
    name: view.name || t(`${CHART_NS}:untitledProperty`),
  });

  function updateChartConfig(patch: Partial<ViewConfig>) {
    if (readOnly) return;
    updateView(view.id, { config: { ...view.config, ...patch } });
  }

  function selectChartAggregate(value: string) {
    const nextAggregate = normalizedChartAggregate(value);
    if (!nextAggregate) return;
    if (!notionChartAggregateRequiresProperty(nextAggregate)) {
      updateChartConfig({ chartAggregate: nextAggregate, chartAggregateBy: undefined });
      return;
    }
    const candidates = props.filter((prop) =>
      notionChartAggregateSupportsProperty(nextAggregate, prop.type)
    );
    const current = candidates.find((prop) => prop.id === aggregateByRef) ?? candidates[0];
    if (!current) return;
    // One user choice produces one view mutation carrying both compatible
    // fields, so observers never see a transient aggregate/property mismatch.
    updateChartConfig({ chartAggregate: nextAggregate, chartAggregateBy: current.id });
  }

  if (!groupProp) {
    return (
      <div className={chartStyles.wrap} data-chart-view>
        <div className={styles.viewEmpty}>
          <div className={styles.viewEmptyTitle}>{t(`${CHART_NS}:noGroupProperty`)}</div>
          <div className={styles.viewEmptyDesc}>{t(`${CHART_NS}:noGroupPropertyDesc`)}</div>
        </div>
      </div>
    );
  }

  const chartTypeOptions = CHART_TYPES.map((type) => ({
    value: type,
    label: t(`${CHART_NS}:chartTypes.${type}`),
  }));
  const xAxisOptions = groupableProps.map((prop) => ({
    value: prop.id,
    label: prop.name || t(`${CHART_NS}:untitledProperty`),
    icon: <PropertyTypeIcon type={prop.type} size={14} />,
  }));
  const yAxisOptions = CHART_AGGREGATES.map((item) => ({
    value: item,
    label: t(`${CHART_NS}:aggregates.${item}`),
    disabled: notionChartAggregateRequiresProperty(item)
      && !props.some((prop) => notionChartAggregateSupportsProperty(item, prop.type)),
  }));
  const valuePropertyOptions = compatibleAggregateProps.map((prop) => ({
    value: prop.id,
    label: prop.name || t(`${CHART_NS}:untitledProperty`),
    icon: <PropertyTypeIcon type={prop.type} size={14} />,
  }));
  const totalValue = series.reduce((sum, entry) => sum + Math.max(0, entry.value), 0);
  const donutCenterText =
    aggregate === "count" || aggregate === "count_values" || aggregate === "sum"
      ? formatValue(totalValue)
      : undefined;

  return (
    <div
      className={chartStyles.wrap}
      data-chart-view
      data-chart-type={chartType}
      data-chart-aggregate={aggregate}
      data-chart-aggregate-property={aggregateBy?.id ?? ""}
      data-chart-unsupported={aggregateSupported ? undefined : "true"}
    >
      {!readOnly && (
        <div className={chartStyles.toolbar} data-chart-config>
          <span className={chartStyles.toolbarLabel}>{t(`${CHART_NS}:chartType`)}</span>
          <NotionSelect
            className={chartStyles.select}
            ariaLabel={t(`${CHART_NS}:chartType`)}
            value={chartType}
            options={chartTypeOptions}
            onChange={(value) => updateChartConfig({ chartType: normalizedChartType(value) ?? "bar" })}
          />
          <span className={chartStyles.toolbarLabel}>{t(`${CHART_NS}:xAxis`)}</span>
          <NotionSelect
            className={chartStyles.select}
            ariaLabel={t(`${CHART_NS}:xAxis`)}
            value={groupProp.id}
            options={xAxisOptions}
            onChange={(value) => updateChartConfig({ chartGroupBy: value || undefined })}
          />
          <span className={chartStyles.toolbarLabel}>{t(`${CHART_NS}:yAxis`)}</span>
          <NotionSelect
            className={chartStyles.select}
            ariaLabel={t(`${CHART_NS}:yAxis`)}
            value={aggregate}
            options={yAxisOptions}
            onChange={selectChartAggregate}
          />
          {aggregate !== "count" && valuePropertyOptions.length > 0 && (
            <NotionSelect
              className={chartStyles.select}
              ariaLabel={t(`${CHART_NS}:valueProperty`)}
              value={aggregateBy?.id ?? ""}
              options={valuePropertyOptions}
              onChange={(value) => updateChartConfig({ chartAggregateBy: value || undefined })}
            />
          )}
        </div>
      )}
      {!aggregateSupported ? (
        <div className={styles.viewEmpty} data-chart-unsupported-state>
          <div className={styles.viewEmptyTitle}>{t(`${CHART_NS}:unsupportedAggregateTitle`)}</div>
          <div className={styles.viewEmptyDesc}>
            {t(`${CHART_NS}:unsupportedAggregateDesc`, {
              aggregate: t(`${CHART_NS}:aggregates.${aggregate}`),
              property: configuredAggregateBy?.name ?? t(`${CHART_NS}:missingProperty`),
            })}
          </div>
        </div>
      ) : shown.length === 0 ? (
        <div className={styles.viewEmpty}>
          <div className={styles.viewEmptyTitle}>{t(`${CHART_NS}:noData`)}</div>
          <div className={styles.viewEmptyDesc}>{t(`${CHART_NS}:noDataDesc`)}</div>
        </div>
      ) : chartType === "donut" ? (
        <DonutChart series={series} ariaLabel={ariaLabel} centerText={donutCenterText} />
      ) : chartType === "horizontal_bar" ? (
        <HorizontalBarChart
          series={series}
          ariaLabel={ariaLabel}
          formatTick={formatValue}
          includeZero={includeZero}
        />
      ) : (
        <ColumnOrLineChart
          series={series}
          line={chartType === "line"}
          ariaLabel={ariaLabel}
          formatTick={formatValue}
          includeZero={includeZero}
        />
      )}
    </div>
  );
}
