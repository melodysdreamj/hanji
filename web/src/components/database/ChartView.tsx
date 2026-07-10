"use client";

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { activeDateLocale, pickLabels } from "@/lib/i18n";
import type { DbProperty, DbView, Page, ViewConfig } from "@/lib/types";
import { useStore } from "@/lib/store";
import { applyView, cellValue } from "./query";
import { dateKey } from "./dateUtils";
import { normalizePersonIds, personLabel } from "./people";
import { formatNumberValue, numberFormatForProperty } from "./numberFormat";
import { nextColor } from "./colors";
import { NotionSelect } from "./NotionSelect";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import styles from "./database.module.css";
import chartStyles from "./chartView.module.css";

export type ChartType = "bar" | "horizontal_bar" | "line" | "donut";
export type ChartAggregate = "count" | "sum" | "average" | "min" | "max";

const CHART_TYPES: ChartType[] = ["bar", "horizontal_bar", "line", "donut"];
const CHART_AGGREGATES: ChartAggregate[] = ["count", "sum", "average", "min", "max"];
const EMPTY_BUCKET_KEY = "__empty";

const CHART_VIEW_LABELS = {
  en: {
    aggregates: { count: "Count", sum: "Sum", average: "Average", min: "Min", max: "Max" },
    chartAria: (name: string) => `${name || "Untitled"} chart`,
    chartType: "Chart type",
    chartTypes: { bar: "Bar", horizontal_bar: "Horizontal bar", line: "Line", donut: "Donut" },
    checked: "Checked",
    empty: "Empty",
    legend: "Chart legend",
    monthLabel: (year: number, month: number) =>
      new Date(year, month - 1, 1).toLocaleDateString(activeDateLocale(), {
        month: "short",
        year: "numeric",
      }),
    noData: "No data",
    noDataDesc: "No rows match the current filters or search.",
    noGroupProperty: "Nothing to chart yet",
    noGroupPropertyDesc: "Add a select, status, person, checkbox, or date property to group this chart.",
    total: "Total",
    unchecked: "Unchecked",
    untitledProperty: "Untitled",
    valueProperty: "Value property",
    xAxis: "X-axis",
    yAxis: "Y-axis",
  },
  ko: {
    aggregates: { count: "개수", sum: "합계", average: "평균", min: "최소", max: "최대" },
    chartAria: (name: string) => `${name || "제목 없음"} 차트`,
    chartType: "차트 유형",
    chartTypes: { bar: "세로 막대", horizontal_bar: "가로 막대", line: "선", donut: "도넛" },
    checked: "체크됨",
    empty: "비어 있음",
    legend: "차트 범례",
    monthLabel: (year: number, month: number) => `${year}년 ${month}월`,
    noData: "데이터 없음",
    noDataDesc: "현재 필터나 검색과 일치하는 행이 없어요.",
    noGroupProperty: "차트로 표시할 속성이 없어요",
    noGroupPropertyDesc: "선택, 상태, 사람, 체크박스 또는 날짜 속성을 추가해 주세요.",
    total: "합계",
    unchecked: "체크 해제",
    untitledProperty: "제목 없음",
    valueProperty: "값 속성",
    xAxis: "X축",
    yAxis: "Y축",
  },
} as const;

type ChartViewLabels = (typeof CHART_VIEW_LABELS)["en"] | (typeof CHART_VIEW_LABELS)["ko"];

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
  return CHART_AGGREGATES.includes(value as ChartAggregate) ? (value as ChartAggregate) : undefined;
}

export function isChartGroupableProperty(prop: DbProperty) {
  return CHART_GROUPABLE_TYPES.has(prop.type);
}

function appendEmptyBucket(buckets: ChartBucket[], rows: Page[], labels: ChartViewLabels): ChartBucket[] {
  if (rows.length === 0) return buckets;
  return [...buckets, { key: EMPTY_BUCKET_KEY, label: labels.empty, color: "default", rows }];
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
  labels: ChartViewLabels,
  fillDateGaps = false
): ChartBucket[] {
  if (prop.type === "checkbox") {
    return [
      { key: "checked", label: labels.checked, color: "green", rows: rows.filter((row) => !!cellValue(row, prop)) },
      { key: "unchecked", label: labels.unchecked, color: "gray", rows: rows.filter((row) => !cellValue(row, prop)) },
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
    return appendEmptyBucket(buckets, empty, labels);
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
      label: labels.monthLabel(Number(key.slice(0, 4)), Number(key.slice(5, 7))),
      color: nextColor(index) as string,
      rows: byMonth.get(key) ?? [],
    }));
    return appendEmptyBucket(buckets, empty, labels);
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
  return appendEmptyBucket(buckets, empty, labels);
}

function bucketNumbers(rows: Page[], prop: DbProperty): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const raw = cellValue(row, prop);
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

export function aggregateChartValue(
  rows: Page[],
  aggregate: ChartAggregate,
  prop?: DbProperty
): number | null {
  if (aggregate === "count" || !prop) return rows.length;
  const values = bucketNumbers(rows, prop);
  // sum/count of an empty bucket is a real 0; average/min/max of no numeric
  // values is "no data" — return null so the caller omits it instead of
  // plotting a misleading 0.
  if (aggregate === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (values.length === 0) return null;
  if (aggregate === "average") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (aggregate === "min") return Math.min(...values);
  return Math.max(...values);
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

const NOTION_CHART_AGGREGATE_TOKENS: Record<string, ChartAggregate> = {
  count: "count",
  count_all: "count",
  count_values: "count",
  show_count: "count",
  sum: "sum",
  total: "sum",
  average: "average",
  avg: "average",
  mean: "average",
  min: "min",
  minimum: "min",
  max: "max",
  maximum: "max",
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
      out.aggregate = NOTION_CHART_AGGREGATE_TOKENS[normalizedToken(entry)];
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
  if (!raw || notionType !== "chart") return {};
  const scan: NotionChartScan = {};
  scanNotionChartRecord(raw, false, scan);
  const groupProp = localPropertyForNotionRef(props, scan.groupByRef);
  const aggregateProp = localPropertyForNotionRef(props, scan.aggregateByRef);
  return {
    chartType: scan.chartType,
    aggregate: scan.aggregate,
    groupById: groupProp && isChartGroupableProperty(groupProp) ? groupProp.id : undefined,
    aggregateById: aggregateProp?.type === "number" ? aggregateProp.id : undefined,
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

function valueTicks(values: number[]): number[] {
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) max = min + 1;
  const step = niceStep((max - min) / 4);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let tick = min; tick <= max + step / 2; tick += step) {
    ticks.push(Math.abs(tick) < step / 1e6 ? 0 : Number(tick.toFixed(6)));
  }
  return ticks;
}

function formatTick(value: number) {
  return formatNumberValue(value, "number");
}

function ColumnOrLineChart({
  series,
  line,
  ariaLabel,
}: {
  series: ChartSeriesEntry[];
  line: boolean;
  ariaLabel: string;
}) {
  const width = 760;
  const height = 320;
  const left = 56;
  const right = width - 16;
  const top = 16;
  const bottom = height - 40;
  const ticks = valueTicks(series.map((entry) => entry.value));
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
            const zero = yFor(0);
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

function HorizontalBarChart({ series, ariaLabel }: { series: ChartSeriesEntry[]; ariaLabel: string }) {
  const width = 760;
  const rowHeight = 30;
  const top = 12;
  const left = 150;
  const right = width - 20;
  const height = top + Math.max(1, series.length) * rowHeight + 34;
  const ticks = valueTicks(series.map((entry) => entry.value));
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
          const zero = xFor(0);
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
  labels,
  centerText,
}: {
  series: ChartSeriesEntry[];
  ariaLabel: string;
  labels: ChartViewLabels;
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
              {labels.total}
            </text>
          </>
        )}
      </svg>
      <ul className={chartStyles.legend} aria-label={labels.legend}>
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
  readOnly = false,
  search,
  contextPageId,
}: {
  db: Page;
  view: DbView;
  rows?: Page[];
  readOnly?: boolean;
  search?: string;
  contextPageId?: string;
}) {
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rows = rowsProp ?? storeRows;
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const updateView = useStore((s) => s.updateView);
  const labels = pickLabels(CHART_VIEW_LABELS);

  const groupableProps = props.filter(isChartGroupableProperty);
  const numberProps = props.filter((prop) => prop.type === "number");
  const recovered = recoveredNotionChartConfig(view, props);

  const chartType = normalizedChartType(view.config?.chartType) ?? recovered.chartType ?? "bar";
  const groupProp =
    groupableProps.find((prop) => prop.id === view.config?.chartGroupBy) ??
    groupableProps.find((prop) => prop.id === recovered.groupById) ??
    groupableProps.find((prop) => prop.type === "select" || prop.type === "status") ??
    groupableProps[0];
  const aggregateBy =
    numberProps.find((prop) => prop.id === view.config?.chartAggregateBy) ??
    numberProps.find((prop) => prop.id === recovered.aggregateById) ??
    numberProps[0];
  const requestedAggregate =
    normalizedChartAggregate(view.config?.chartAggregate) ?? recovered.aggregate ?? "count";
  // Non-count aggregations need a number property to read from.
  const aggregate: ChartAggregate = requestedAggregate !== "count" && !aggregateBy ? "count" : requestedAggregate;

  // Memoized like TableView's `shown`: applyView runs a full search-filter +
  // filter-group + multi-key sort over every loaded row on each render.
  const shown = useMemo(
    () => applyView(rows, props, view, pagesById, { search, currentPageId: contextPageId }),
    [rows, props, view, pagesById, search, contextPageId]
  );
  const numberFormat = aggregate !== "count" && aggregateBy ? numberFormatForProperty(aggregateBy) : "number";
  const formatValue = (value: number) => formatNumberValue(value, numberFormat);
  const buckets = groupProp ? chartBuckets(shown, groupProp, labels, chartType === "line") : [];
  const series: ChartSeriesEntry[] = buckets.flatMap((bucket) => {
    const value = aggregateChartValue(bucket.rows, aggregate, aggregateBy);
    // null => empty average/min/max bucket: omit rather than plot a false 0.
    if (value === null) return [];
    return [{ ...bucket, value, formatted: formatValue(value) }];
  });
  const ariaLabel = labels.chartAria(view.name);

  function updateChartConfig(patch: Partial<ViewConfig>) {
    if (readOnly) return;
    updateView(view.id, { config: { ...view.config, ...patch } });
  }

  if (!groupProp) {
    return (
      <div className={chartStyles.wrap} data-chart-view>
        <div className={styles.viewEmpty}>
          <div className={styles.viewEmptyTitle}>{labels.noGroupProperty}</div>
          <div className={styles.viewEmptyDesc}>{labels.noGroupPropertyDesc}</div>
        </div>
      </div>
    );
  }

  const chartTypeOptions = CHART_TYPES.map((type) => ({ value: type, label: labels.chartTypes[type] }));
  const xAxisOptions = groupableProps.map((prop) => ({
    value: prop.id,
    label: prop.name || labels.untitledProperty,
    icon: <PropertyTypeIcon type={prop.type} size={14} />,
  }));
  const yAxisOptions = CHART_AGGREGATES.map((item) => ({
    value: item,
    label: labels.aggregates[item],
    disabled: item !== "count" && numberProps.length === 0,
  }));
  const valuePropertyOptions = numberProps.map((prop) => ({
    value: prop.id,
    label: prop.name || labels.untitledProperty,
    icon: <PropertyTypeIcon type={prop.type} size={14} />,
  }));
  const totalValue = series.reduce((sum, entry) => sum + Math.max(0, entry.value), 0);
  const donutCenterText =
    aggregate === "count" || aggregate === "sum" ? formatValue(totalValue) : undefined;

  return (
    <div className={chartStyles.wrap} data-chart-view data-chart-type={chartType}>
      {!readOnly && (
        <div className={chartStyles.toolbar} data-chart-config>
          <span className={chartStyles.toolbarLabel}>{labels.chartType}</span>
          <NotionSelect
            className={chartStyles.select}
            ariaLabel={labels.chartType}
            value={chartType}
            options={chartTypeOptions}
            onChange={(value) => updateChartConfig({ chartType: normalizedChartType(value) ?? "bar" })}
          />
          <span className={chartStyles.toolbarLabel}>{labels.xAxis}</span>
          <NotionSelect
            className={chartStyles.select}
            ariaLabel={labels.xAxis}
            value={groupProp.id}
            options={xAxisOptions}
            onChange={(value) => updateChartConfig({ chartGroupBy: value || undefined })}
          />
          <span className={chartStyles.toolbarLabel}>{labels.yAxis}</span>
          <NotionSelect
            className={chartStyles.select}
            ariaLabel={labels.yAxis}
            value={aggregate}
            options={yAxisOptions}
            onChange={(value) => updateChartConfig({ chartAggregate: normalizedChartAggregate(value) ?? "count" })}
          />
          {aggregate !== "count" && aggregateBy && (
            <NotionSelect
              className={chartStyles.select}
              ariaLabel={labels.valueProperty}
              value={aggregateBy.id}
              options={valuePropertyOptions}
              onChange={(value) => updateChartConfig({ chartAggregateBy: value || undefined })}
            />
          )}
        </div>
      )}
      {shown.length === 0 ? (
        <div className={styles.viewEmpty}>
          <div className={styles.viewEmptyTitle}>{labels.noData}</div>
          <div className={styles.viewEmptyDesc}>{labels.noDataDesc}</div>
        </div>
      ) : chartType === "donut" ? (
        <DonutChart series={series} ariaLabel={ariaLabel} labels={labels} centerText={donutCenterText} />
      ) : chartType === "horizontal_bar" ? (
        <HorizontalBarChart series={series} ariaLabel={ariaLabel} />
      ) : (
        <ColumnOrLineChart series={series} line={chartType === "line"} ariaLabel={ariaLabel} />
      )}
    </div>
  );
}
