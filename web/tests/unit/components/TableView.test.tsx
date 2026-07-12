// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updatePageRemote: vi.fn(async () => undefined),
    updatePropertyRemote: vi.fn(async () => undefined),
    updateViewRemote: vi.fn(async () => undefined),
  };
});

import { TableView } from "@/components/database/TableView";
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

const DB_ID = "db-table";

function seedTable(rows: Page[]) {
  const db = makePage({ id: DB_ID, kind: "database", title: "Tasks" });
  seedPages([db, ...rows]);
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
    makeProp(DB_ID, { id: "done", type: "checkbox", name: "Done", position: 2 }),
    makeProp(DB_ID, { id: "amount", type: "number", name: "Amount", position: 3 }),
  ]);
  // dbRows reads loaded row ids first; mirrors what loadDatabaseRows stores.
  useStore.setState((s) => ({
    databaseRowIdsByDb: {
      ...s.databaseRowIdsByDb,
      [DB_ID]: rows.map((row) => row.id),
    },
  }));
  return db;
}

function defaultRows(): Page[] {
  return [
    makeRow(DB_ID, {
      id: "row-a",
      title: "Alpha task",
      position: 0,
      properties: { status: "o-todo", done: false, amount: 10 },
    }),
    makeRow(DB_ID, {
      id: "row-b",
      title: "Beta task",
      position: 1,
      properties: { status: "o-done", done: true, amount: 30 },
    }),
    makeRow(DB_ID, {
      id: "row-c",
      title: "Gamma task",
      position: 2,
      properties: { status: "o-todo", done: true, amount: 20 },
    }),
  ];
}

function renderTable(view: DbView, rows: Page[] = defaultRows()) {
  const db = seedTable(rows);
  seedDbViews(DB_ID, [view]);
  return render(<TableView db={db} view={view} />);
}

function rowTitles(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>("[data-table-title-input]")
  ).map((input) => input.value);
}

beforeEach(() => {
  resetStore();
  seedUser();
});
afterEach(cleanup);

describe("TableView", () => {
  it("renders a row per store record in position order plus the new-row button", () => {
    const { container } = renderTable(makeView(DB_ID, { id: "v1", type: "table" }));

    expect(container.querySelectorAll("[data-table-row-id]")).toHaveLength(3);
    expect(rowTitles(container)).toEqual(["Alpha task", "Beta task", "Gamma task"]);
    expect(screen.getByRole("button", { name: "New page in Tasks" })).toBeTruthy();
  });

  it("renders a column header for every property that is not hidden", () => {
    const { container } = renderTable(
      makeView(DB_ID, {
        id: "v1",
        type: "table",
        config: { hiddenProperties: ["amount"] },
      })
    );

    const head = container.querySelector("[data-table-head]");
    expect(head?.textContent).toContain("Name");
    expect(head?.textContent).toContain("Status");
    expect(head?.textContent).toContain("Done");
    expect(head?.textContent).not.toContain("Amount");
  });

  it("exposes the table as a named grid with row, columnheader, and gridcell semantics", () => {
    renderTable(makeView(DB_ID, { id: "v-grid", type: "table" }));

    const grid = screen.getByRole("grid", { name: "Tasks table" });
    expect(grid.getAttribute("aria-rowcount")).toBe("4");
    expect(grid.getAttribute("aria-colcount")).toBe("6");
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getAllByRole("columnheader")).toHaveLength(6);
    expect(screen.getAllByRole("gridcell", { name: "Name for Alpha task" })).toHaveLength(1);
    expect(screen.getByRole("columnheader", { name: "Table actions" })).toBeTruthy();
    expect(screen.getByRole("gridcell", { name: "Table actions for Alpha task" })).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { name: "Edit Done" })).toHaveLength(3);
  });

  it("resizes a property column from the keyboard and persists the view width", () => {
    const view = makeView(DB_ID, { id: "v-resize-keyboard", type: "table" });
    renderTable(view);
    const resize = screen.getByRole("button", { name: /^Resize Status column/ });

    fireEvent.keyDown(resize, { key: "ArrowRight" });
    expect(
      useStore.getState().dbViews(DB_ID).find((item) => item.id === view.id)?.config?.propertyWidths?.status
    ).toBe(190);
  });

  it("labels the database row action search", () => {
    renderTable(makeView(DB_ID, { id: "v-row-menu-label", type: "table" }));

    fireEvent.click(screen.getByRole("button", { name: "Alpha task row menu" }));
    expect(screen.getByRole("searchbox", { name: "Search actions" })).toBeTruthy();
  });

  it("applies the view's sort configuration to the rendered order", () => {
    const { container } = renderTable(
      makeView(DB_ID, {
        id: "v1",
        type: "table",
        config: { sorts: [{ propertyId: "amount", direction: "desc" }] },
      })
    );

    expect(rowTitles(container)).toEqual(["Beta task", "Gamma task", "Alpha task"]);
  });

  it("applies the view's filters to the rendered rows", () => {
    const { container } = renderTable(
      makeView(DB_ID, {
        id: "v1",
        type: "table",
        config: {
          filters: [{ propertyId: "done", operator: "equals", value: true }],
        },
      })
    );

    expect(rowTitles(container)).toEqual(["Beta task", "Gamma task"]);
  });

  it("combines filters through a nested OR filter group", () => {
    const { container } = renderTable(
      makeView(DB_ID, {
        id: "v1",
        type: "table",
        config: {
          filterGroup: {
            conjunction: "or",
            filters: [
              { propertyId: "status", operator: "equals", value: "o-done" },
              { propertyId: "amount", operator: "less_than", value: 15 },
            ],
          },
        },
      })
    );

    expect(rowTitles(container)).toEqual(["Alpha task", "Beta task"]);
  });

  it("shows the no-results state when a search matches nothing", () => {
    const db = seedTable(defaultRows());
    const { container } = render(
      <TableView db={db} view={makeView(DB_ID, { id: "v1", type: "table" })} search="zzz" />
    );

    expect(container.querySelectorAll("[data-table-row-id]")).toHaveLength(0);
    expect(container.querySelector("[data-table-empty-results]")?.textContent).toContain(
      "No results"
    );
  });

  it("narrows rows with the search text", () => {
    const db = seedTable(defaultRows());
    const { container } = render(
      <TableView db={db} view={makeView(DB_ID, { id: "v1", type: "table" })} search="beta" />
    );
    expect(rowTitles(container)).toEqual(["Beta task"]);
  });

  it("renders select chips and checkbox cells from row values", () => {
    const { container } = renderTable(makeView(DB_ID, { id: "v1", type: "table" }));

    const statusCells = screen.getAllByRole("group", { name: "Status" });
    expect(statusCells.map((cell) => cell.textContent?.trim())).toEqual(["Todo", "Done", "Todo"]);

    // Scope to property cells: the row gutter renders row-select checkboxes too.
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        '[data-table-cell] input[type="checkbox"]'
      )
    );
    expect(checkboxes.map((box) => box.checked)).toEqual([false, true, true]);
  });

  it("commits a title edit from the table's title cell to the store", () => {
    const { container } = renderTable(makeView(DB_ID, { id: "v1", type: "table" }));

    const input = container.querySelector<HTMLInputElement>("[data-table-title-input]")!;
    fireEvent.change(input, { target: { value: "Alpha renamed" } });
    fireEvent.blur(input);

    expect(useStore.getState().pagesById["row-a"].title).toBe("Alpha renamed");
  });

  it("hides mutating chrome in read-only mode", () => {
    const db = seedTable(defaultRows());
    const { container } = render(
      <TableView db={db} view={makeView(DB_ID, { id: "v1", type: "table" })} readOnly />
    );

    expect(screen.queryByRole("button", { name: "New page in Tasks" })).toBeNull();
    expect(container.querySelectorAll("[data-table-row-id]")).toHaveLength(3);
  });
});
