// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    createViewRemote: vi.fn(async () => undefined),
    updateViewRemote: vi.fn(async () => undefined),
    deleteViewRemote: vi.fn(async () => undefined),
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updatePropertyRemote: vi.fn(async () => undefined),
    getDatabaseRowsRemote: vi.fn(async () => ({ rows: [] })),
    getDatabaseSnapshotRemote: vi.fn(async () => ({ properties: [], views: [], templates: [] })),
  };
});

import { ChartView } from "@/components/database/ChartView";
import { useStore } from "@/lib/store";
import type { DbProperty, DbView, Page } from "@/lib/types";
import {
  makePage,
  makeProp,
  makeRow,
  resetStore,
  seedDbProps,
  seedPages,
  seedUser,
} from "./storeTestUtils";
import { makeView, seedDbViews } from "./editorTestUtils";

const DB_ID = "db-chart";

function defaultProps(): DbProperty[] {
  return [
    makeProp(DB_ID, { id: "title", type: "title", name: "Name", position: 0 }),
    makeProp(DB_ID, {
      id: "status",
      type: "select",
      name: "Status",
      position: 1,
      config: {
        options: [
          { id: "o-todo", name: "Todo", color: "blue" },
          { id: "o-done", name: "Done", color: "green" },
        ],
      },
    }),
    makeProp(DB_ID, {
      id: "tags",
      type: "multi_select",
      name: "Tags",
      position: 2,
      config: {
        options: [
          { id: "t-a", name: "Alpha", color: "purple" },
          { id: "t-b", name: "Beta", color: "pink" },
        ],
      },
    }),
    makeProp(DB_ID, { id: "done", type: "checkbox", name: "Done?", position: 3 }),
    makeProp(DB_ID, { id: "due", type: "date", name: "Due", position: 4 }),
    makeProp(DB_ID, { id: "points", type: "number", name: "Points", position: 5 }),
  ];
}

function defaultRows(): Page[] {
  return [
    makeRow(DB_ID, {
      id: "row-1",
      title: "One",
      position: 0,
      properties: { status: "o-todo", tags: ["t-a", "t-b"], done: true, due: "2026-07-01", points: 5 },
    }),
    makeRow(DB_ID, {
      id: "row-2",
      title: "Two",
      position: 1,
      properties: { status: "o-todo", tags: ["t-a"], done: false, due: "2026-05-15", points: 7 },
    }),
    makeRow(DB_ID, {
      id: "row-3",
      title: "Three",
      position: 2,
      properties: { status: "o-done", tags: [], done: false, due: "2026-07-20", points: 2 },
    }),
    makeRow(DB_ID, {
      id: "row-4",
      title: "Four",
      position: 3,
      properties: {},
    }),
  ];
}

function seedChartDatabase({
  props = defaultProps(),
  rows = defaultRows(),
  view,
}: {
  props?: DbProperty[];
  rows?: Page[];
  view: DbView;
}) {
  const db = makePage({ id: DB_ID, kind: "database", title: "Tasks" });
  seedPages([db, ...rows]);
  seedDbProps(DB_ID, props);
  seedDbViews(DB_ID, [view]);
  return { db, rows };
}

// Mirrors DatabaseView's production flow: the view comes from the store, so
// config changes persisted via updateView re-render the chart.
function ChartHarness({ db, rows, readOnly }: { db: Page; rows: Page[]; readOnly?: boolean }) {
  const view = useStore((s) => (s.viewsByDb[DB_ID] ?? []).find((item) => item.id === "v-chart"));
  if (!view) return null;
  return <ChartView db={db} view={view} rows={rows} readOnly={readOnly} />;
}

function renderChart(
  view: DbView,
  opts: { props?: DbProperty[]; rows?: Page[]; readOnly?: boolean } = {}
) {
  const { db, rows } = seedChartDatabase({ props: opts.props, rows: opts.rows, view });
  return render(<ChartHarness db={db} rows={rows} readOnly={opts.readOnly} />);
}

function chartView(overrides: Partial<DbView> = {}) {
  return makeView(DB_ID, { id: "v-chart", name: "Chart", type: "chart", position: 0, ...overrides });
}

function barTitles(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[data-chart-bar]")).map(
    (bar) => bar.querySelector("title")?.textContent
  );
}

beforeEach(() => {
  resetStore();
  seedUser();
});
afterEach(cleanup);

describe("ChartView", () => {
  it("groups rows by the default select property and counts them, with an Empty bucket", () => {
    const { container } = renderChart(chartView());
    expect(screen.getByRole("img", { name: "Chart chart" })).toBeTruthy();
    expect(barTitles(container)).toEqual(["Todo: 2", "Done: 1", "Empty: 1"]);
  });

  it("respects the view's filters like other views", () => {
    const { container } = renderChart(
      chartView({
        config: {
          filterGroup: {
            conjunction: "and",
            filters: [{ propertyId: "status", operator: "equals", value: "o-todo" }],
          },
        },
      })
    );
    // Only the two Todo rows survive the filter: no Empty bucket, Done at 0.
    expect(barTitles(container)).toEqual(["Todo: 2", "Done: 0"]);
  });

  it("sums a number property when configured", () => {
    const { container } = renderChart(
      chartView({ config: { chartAggregate: "sum", chartAggregateBy: "points" } })
    );
    expect(barTitles(container)).toEqual(["Todo: 12", "Done: 2", "Empty: 0"]);
  });

  it("averages a number property when configured", () => {
    const { container } = renderChart(
      chartView({ config: { chartAggregate: "average", chartAggregateBy: "points" } })
    );
    // The Empty bucket has no numeric points, so its average is "no data" and is
    // omitted rather than plotted as a misleading real 0 (sum/count keep 0).
    expect(barTitles(container)).toEqual(["Todo: 6", "Done: 2"]);
  });

  it("falls back to count when no number property exists for a non-count aggregation", () => {
    const props = defaultProps().filter((prop) => prop.id !== "points");
    const { container } = renderChart(chartView({ config: { chartAggregate: "sum" } }), { props });
    expect(barTitles(container)).toEqual(["Todo: 2", "Done: 1", "Empty: 1"]);
  });

  it("buckets checkbox values into Checked and Unchecked", () => {
    const { container } = renderChart(chartView({ config: { chartGroupBy: "done" } }));
    expect(barTitles(container)).toEqual(["Checked: 1", "Unchecked: 3"]);
  });

  it("buckets dates by month in ascending order with an Empty bucket", () => {
    const { container } = renderChart(chartView({ config: { chartGroupBy: "due" } }));
    const keys = Array.from(container.querySelectorAll("[data-chart-bar]")).map((bar) =>
      bar.getAttribute("data-chart-bar")
    );
    expect(keys).toEqual(["2026-05", "2026-07", "__empty"]);
    expect(barTitles(container)).toEqual(["May 2026: 1", "Jul 2026: 2", "Empty: 1"]);
  });

  it("counts multi-select rows in every selected option bucket", () => {
    const { container } = renderChart(chartView({ config: { chartGroupBy: "tags" } }));
    expect(barTitles(container)).toEqual(["Alpha: 2", "Beta: 1", "Empty: 2"]);
  });

  it("renders a horizontal bar layout when configured", () => {
    const { container } = renderChart(chartView({ config: { chartType: "horizontal_bar" } }));
    expect(container.querySelector("[data-chart-view]")?.getAttribute("data-chart-type")).toBe(
      "horizontal_bar"
    );
    expect(barTitles(container)).toEqual(["Todo: 2", "Done: 1", "Empty: 1"]);
  });

  it("renders a line chart with one point per bucket", () => {
    const { container } = renderChart(chartView({ config: { chartType: "line" } }));
    const points = Array.from(container.querySelectorAll("[data-chart-point]"));
    expect(points.map((point) => point.getAttribute("data-chart-point"))).toEqual([
      "o-todo",
      "o-done",
      "__empty",
    ]);
    expect(points[0]?.querySelector("title")?.textContent).toBe("Todo: 2");
  });

  it("renders a donut with segments and a legend", () => {
    const { container } = renderChart(chartView({ config: { chartType: "donut" } }));
    const segments = Array.from(container.querySelectorAll("[data-chart-segment]"));
    expect(segments.map((segment) => segment.getAttribute("data-chart-segment"))).toEqual([
      "o-todo",
      "o-done",
      "__empty",
    ]);
    const legend = screen.getByRole("list", { name: "Chart legend" });
    expect(legend.textContent).toContain("Todo");
    expect(legend.textContent).toContain("2 · 50%");
  });

  it("shows the no-data empty state when no rows match", () => {
    renderChart(chartView(), { rows: [] });
    expect(screen.getByText("No data")).toBeTruthy();
    expect(screen.getByText("No rows match the current filters or search.")).toBeTruthy();
  });

  it("prompts for a groupable property when the database has none", () => {
    const props = [
      makeProp(DB_ID, { id: "title", type: "title", name: "Name", position: 0 }),
      makeProp(DB_ID, { id: "points", type: "number", name: "Points", position: 1 }),
    ];
    renderChart(chartView(), { props });
    expect(screen.getByText("Nothing to chart yet")).toBeTruthy();
  });

  it("hides the config toolbar in read-only mode but still renders the chart", () => {
    const { container } = renderChart(chartView(), { readOnly: true });
    expect(container.querySelector("[data-chart-config]")).toBeNull();
    expect(barTitles(container)).toEqual(["Todo: 2", "Done: 1", "Empty: 1"]);
  });

  it("persists chart type changes into the view config through updateView", () => {
    renderChart(chartView());
    fireEvent.click(screen.getByRole("button", { name: "Chart type" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Donut" }));
    const stored = useStore.getState().viewsByDb[DB_ID]?.find((item) => item.id === "v-chart");
    expect(stored?.config?.chartType).toBe("donut");
  });

  it("persists x-axis and aggregation changes into the view config", () => {
    renderChart(chartView());
    fireEvent.click(screen.getByRole("button", { name: "X-axis" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Due" }));
    fireEvent.click(screen.getByRole("button", { name: "Y-axis" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sum" }));
    const stored = useStore.getState().viewsByDb[DB_ID]?.find((item) => item.id === "v-chart");
    expect(stored?.config?.chartGroupBy).toBe("due");
    expect(stored?.config?.chartAggregate).toBe("sum");
  });

  it("recovers chart settings from an imported Notion chart view", () => {
    const props = defaultProps();
    props[1] = {
      ...props[1],
      config: { ...props[1].config, notionPropertyId: "notion-status" },
    };
    const { container } = renderChart(
      chartView({
        config: {
          notionViewId: "nv-1",
          notionType: "chart",
          notion: {
            id: "nv-1",
            type: "chart",
            format: {
              chart: {
                type: "donut",
                x_axis: { property: "notion-status" },
                y_axis: { aggregation: "count" },
              },
            },
          },
        },
      }),
      { props }
    );
    expect(container.querySelector("[data-chart-view]")?.getAttribute("data-chart-type")).toBe(
      "donut"
    );
    const legend = screen.getByRole("list", { name: "Chart legend" });
    expect(legend.textContent).toContain("Todo");
  });
});
