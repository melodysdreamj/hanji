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

import { DatabaseView } from "@/components/database/DatabaseView";
import { useStore } from "@/lib/store";
import type { DbView, Page } from "@/lib/types";
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

const DB_ID = "db-views";

function seedDatabase(views: DbView[], rows?: Page[]) {
  const db = makePage({ id: DB_ID, kind: "database", title: "Tasks" });
  const seededRows = rows ?? [
    makeRow(DB_ID, {
      id: "row-1",
      title: "Task one",
      position: 0,
      properties: { status: "o-todo", due: "2026-07-01" },
    }),
    makeRow(DB_ID, {
      id: "row-2",
      title: "Task two",
      position: 1,
      properties: { status: "o-done", due: "2026-07-02" },
    }),
  ];
  seedPages([db, ...seededRows]);
  seedDbProps(DB_ID, [
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
    makeProp(DB_ID, { id: "due", type: "date", name: "Due", position: 2 }),
  ]);
  seedDbViews(DB_ID, views);
  useStore.setState((s) => ({
    databaseRowIdsByDb: {
      ...s.databaseRowIdsByDb,
      [DB_ID]: seededRows.map((row) => row.id),
    },
  }));
  return db;
}

function renderDatabase(views: DbView[], opts: { initialViewId?: string } = {}) {
  const db = seedDatabase(views);
  return render(
    <DatabaseView db={db} skipRemoteLoad syncUrl={false} initialViewId={opts.initialViewId} />
  );
}

const ALL_VIEWS = [
  makeView(DB_ID, { id: "v-table", name: "Table", type: "table", position: 0 }),
  makeView(DB_ID, {
    id: "v-board",
    name: "Board",
    type: "board",
    position: 1,
    config: { groupBy: "status" },
  }),
  makeView(DB_ID, { id: "v-list", name: "List", type: "list", position: 2 }),
  makeView(DB_ID, { id: "v-gallery", name: "Gallery", type: "gallery", position: 3 }),
  makeView(DB_ID, {
    id: "v-calendar",
    name: "Calendar",
    type: "calendar",
    position: 4,
    config: { calendarBy: "due" },
  }),
  makeView(DB_ID, {
    id: "v-timeline",
    name: "Timeline",
    type: "timeline",
    position: 5,
    config: { timelineBy: "due" },
  }),
];

beforeEach(() => {
  resetStore();
  seedUser();
});
afterEach(cleanup);

describe("DatabaseView", () => {
  it("renders the loading shell until view/property metadata exists", () => {
    const db = makePage({ id: DB_ID, kind: "database", title: "Tasks" });
    seedPages([db]);
    render(<DatabaseView db={db} skipRemoteLoad syncUrl={false} />);
    expect(screen.getByLabelText("Loading database")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("renders one tab per view and activates the first view's table by default", () => {
    const { container } = renderDatabase(ALL_VIEWS);

    const tablist = screen.getByRole("tablist", { name: "Tasks views" });
    expect(tablist).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Table",
      "Board",
      "List",
      "Gallery",
      "Calendar",
      "Timeline",
    ]);
    expect(screen.getByRole("tab", { name: "Table" }).getAttribute("aria-selected")).toBe(
      "true"
    );

    // The table panel shows a title cell per row.
    const titleInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("[data-table-title-input]")
    );
    expect(titleInputs.map((input) => input.value)).toEqual(["Task one", "Task two"]);
  });

  it("switches to the board view when its tab is clicked", () => {
    const { container } = renderDatabase(ALL_VIEWS);

    fireEvent.click(screen.getByRole("tab", { name: "Board" }));

    expect(screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    expect(container.querySelector("[data-table-title-input]")).toBeNull();
    // Board columns come from the grouped select options.
    expect(screen.getByRole("button", { name: "Todo group actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done group actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Task one" })).toBeTruthy();
  });

  it("renders the list view rows for an initial list view", () => {
    const { container } = renderDatabase(ALL_VIEWS, { initialViewId: "v-list" });
    expect(screen.getByRole("tab", { name: "List" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    expect(screen.getByRole("button", { name: "Open Task one" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Task two" })).toBeTruthy();
    // Gallery-style cards carry a data-size attribute; list rows do not.
    expect(container.querySelector("[data-size]")).toBeNull();
  });

  it("renders gallery cards for an initial gallery view", () => {
    const { container } = renderDatabase(ALL_VIEWS, { initialViewId: "v-gallery" });
    expect(container.querySelector("[data-size]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Task one" })).toBeTruthy();
  });

  it("renders the calendar chrome for an initial calendar view", () => {
    renderDatabase(ALL_VIEWS, { initialViewId: "v-calendar" });
    expect(screen.getByRole("button", { name: "Previous month" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next month" })).toBeTruthy();
  });

  it("renders the timeline chrome for an initial timeline view", () => {
    renderDatabase(ALL_VIEWS, { initialViewId: "v-timeline" });
    expect(screen.getByRole("group", { name: "Timeline zoom" })).toBeTruthy();
  });

  it("renders the chart view for a chart-type view", () => {
    const chart = makeView(DB_ID, {
      id: "v-chart",
      name: "Chart",
      type: "chart",
      position: 0,
    });
    const { container } = renderDatabase([chart]);

    // The real chart renderer replaced the imported-unsupported placeholder.
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("img", { name: "Chart chart" })).toBeTruthy();
    // Default grouping picks the seeded status select: one bar per option.
    const bars = Array.from(container.querySelectorAll("[data-chart-bar]"));
    expect(bars.map((bar) => bar.getAttribute("data-chart-bar"))).toEqual(["o-todo", "o-done"]);
    expect(bars.map((bar) => bar.querySelector("title")?.textContent)).toEqual([
      "Todo: 1",
      "Done: 1",
    ]);
  });

  it("offers Chart in the add-view menu", () => {
    renderDatabase(ALL_VIEWS);
    fireEvent.click(screen.getByRole("button", { name: "Add view" }));
    expect(
      screen.getByRole("radio", { name: /Chart/ })
    ).toBeTruthy();
  });
});
