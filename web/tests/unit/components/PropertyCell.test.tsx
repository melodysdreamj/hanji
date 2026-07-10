// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updatePropertyRemote: vi.fn(async () => undefined),
    searchOrganizationPeopleRemote: vi.fn(async () => ({ people: [] })),
  };
});

import { PropertyCell } from "@/components/database/PropertyCell";
import { useStore } from "@/lib/store";
import type { PropertyType } from "@/lib/types";
import {
  makePage,
  makeProp,
  makeRow,
  resetStore,
  seedDbProps,
  seedPages,
  seedUser,
} from "./storeTestUtils";

const DB_ID = "db-1";

function rowValue(rowId: string, propId: string) {
  return useStore.getState().pagesById[rowId]?.properties?.[propId];
}

beforeEach(() => {
  resetStore();
  seedUser();
  seedPages([makePage({ id: DB_ID, kind: "database", title: "Tasks" })]);
});
afterEach(cleanup);

describe("PropertyCell", () => {
  it("renders a checkbox from the row value and commits the toggle to the store", () => {
    const prop = makeProp(DB_ID, { id: "done", type: "checkbox", name: "Done" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", title: "Task one", properties: { done: false } });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(rowValue("row-1", "done")).toBe(true);
  });

  it("renders the selected option chip and commits a different option from the menu", () => {
    const prop = makeProp(DB_ID, {
      id: "status",
      type: "select",
      name: "Status",
      config: {
        options: [
          { id: "o-todo", name: "Todo", color: "blue" },
          { id: "o-done", name: "Done", color: "green" },
        ],
      },
    });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", properties: { status: "o-todo" } });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    const trigger = screen.getByRole("button", { name: "Edit Status select" });
    expect(trigger.textContent).toContain("Todo");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "Edit select property" });
    expect(menu).toBeTruthy();
    const doneOption = screen
      .getAllByRole("option")
      .find((option) => option.textContent?.includes("Done"));
    expect(doneOption).toBeTruthy();
    fireEvent.click(doneOption!);

    expect(rowValue("row-1", "status")).toBe("o-done");
    // Single select closes the menu after the pick.
    expect(screen.queryByRole("dialog", { name: "Edit select property" })).toBeNull();
  });

  it("renders every selected multi-select chip and removes one via its chip button", () => {
    const prop = makeProp(DB_ID, {
      id: "tags",
      type: "multi_select",
      name: "Tags",
      config: {
        options: [
          { id: "t-a", name: "Alpha", color: "blue" },
          { id: "t-b", name: "Beta", color: "red" },
        ],
      },
    });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", properties: { tags: ["t-a", "t-b"] } });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    const trigger = screen.getByRole("button", { name: "Edit Tags multi-select" });
    expect(trigger.textContent).toContain("Alpha");
    expect(trigger.textContent).toContain("Beta");

    fireEvent.click(screen.getByRole("button", { name: "Remove Beta" }));
    expect(rowValue("row-1", "tags")).toEqual(["t-a"]);
  });

  it("renders a stored date key in display format on the date trigger", () => {
    const prop = makeProp(DB_ID, { id: "due", type: "date", name: "Due" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", properties: { due: "2025-03-09" } });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    const trigger = screen.getByRole("button", { name: /^Edit date/ });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.textContent).toContain("Mar 9, 2025");
  });

  it("shows the number display, then commits an edited draft (tolerating separators)", () => {
    const prop = makeProp(DB_ID, { id: "amount", type: "number", name: "Amount" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", properties: { amount: 1500 } });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    const display = screen.getByRole("button", { name: "Edit Amount" });
    expect(display.textContent).toBe("1500");

    fireEvent.click(display);
    const input = screen.getByDisplayValue("1500") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2,500" } });
    fireEvent.blur(input);
    expect(rowValue("row-1", "amount")).toBe(2500);
  });

  it("shows the backend-computed text for formula and rollup properties", () => {
    const formulaProp = makeProp(DB_ID, { id: "f1", type: "formula", name: "Formula" });
    const rollupProp = makeProp(DB_ID, { id: "r1", type: "rollup", name: "Rollup" });
    seedDbProps(DB_ID, [formulaProp, rollupProp]);
    const row = makeRow(DB_ID, {
      id: "row-1",
      __computed: {
        f1: { formatted: "Total: 42", value: 42 },
        r1: { formatted: "3 items", value: 3 },
      },
    });
    seedPages([row]);

    const { unmount } = render(<PropertyCell row={row} prop={formulaProp} />);
    expect(screen.getByText("Total: 42")).toBeTruthy();
    unmount();

    render(<PropertyCell row={row} prop={rollupProp} />);
    expect(screen.getByText("3 items")).toBeTruthy();
  });

  it("shows a pending placeholder for a rollup whose target property has not loaded", () => {
    const rollupProp = makeProp(DB_ID, {
      id: "r1",
      type: "rollup",
      name: "Rollup",
      config: { rollupTargetPropertyId: "missing-target" },
    });
    seedDbProps(DB_ID, [rollupProp]);
    const row = makeRow(DB_ID, { id: "row-1" });
    seedPages([row]);

    const { container } = render(<PropertyCell row={row} prop={rollupProp} />);
    expect(container.textContent).toBe("…");
  });

  it("prefixes unique_id values and leaves empty values blank", () => {
    const prop = makeProp(DB_ID, {
      id: "uid",
      type: "unique_id",
      name: "ID",
      config: { idPrefix: "TASK" },
    });
    seedDbProps(DB_ID, [prop]);
    const filled = makeRow(DB_ID, { id: "row-1", properties: { uid: 7 } });
    const empty = makeRow(DB_ID, { id: "row-2", properties: {} });
    seedPages([filled, empty]);

    const { container, unmount } = render(<PropertyCell row={filled} prop={prop} />);
    expect(container.textContent).toBe("TASK-7");
    unmount();

    const { container: emptyContainer } = render(<PropertyCell row={empty} prop={prop} />);
    expect(emptyContainer.textContent).toBe("");
  });

  it("renders created_time as a read-only formatted timestamp", () => {
    const prop = makeProp(DB_ID, { id: "ct", type: "created_time", name: "Created" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", createdAt: "2026-07-04T09:30:00" });
    seedPages([row]);

    const { container } = render(<PropertyCell row={row} prop={prop} />);
    expect(container.textContent).toBe("July 4, 2026 9:30 AM");
  });

  it("renders url values as an editable display plus an external open link", () => {
    const prop = makeProp(DB_ID, { id: "site", type: "url", name: "Site" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", properties: { site: "example.com" } });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    const open = screen.getByRole("link", { name: "Open example.com" });
    expect(open.getAttribute("href")).toBe("https://example.com");
    expect(open.getAttribute("target")).toBe("_blank");

    fireEvent.click(screen.getByRole("button", { name: "Edit Site" }));
    expect((screen.getByDisplayValue("example.com") as HTMLInputElement).value).toBe(
      "example.com"
    );
  });

  it("blanks the legacy 'Untitled' fallback in database title cells", () => {
    const prop = makeProp(DB_ID, { id: "title", type: "title", name: "Name" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", title: "Untitled" });
    seedPages([row]);

    const { container } = render(<PropertyCell row={row} prop={prop} />);
    const input = container.querySelector<HTMLInputElement>("[data-table-title-input]");
    expect(input).toBeTruthy();
    expect(input!.value).toBe("");
  });

  it("commits a title edit through updatePage", () => {
    const prop = makeProp(DB_ID, { id: "title", type: "title", name: "Name" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", title: "Task one" });
    seedPages([row]);

    const { container } = render(<PropertyCell row={row} prop={prop} />);
    const input = container.querySelector<HTMLInputElement>("[data-table-title-input]")!;
    fireEvent.change(input, { target: { value: "Task renamed" } });
    fireEvent.blur(input);
    expect(useStore.getState().pagesById["row-1"].title).toBe("Task renamed");
  });

  it("falls back to a text input for an unknown property type", () => {
    const prop = makeProp(DB_ID, {
      id: "mystery",
      type: "mystery" as unknown as PropertyType,
      name: "Mystery",
    });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", properties: { mystery: "kept as text" } });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    expect((screen.getByDisplayValue("kept as text") as HTMLInputElement).value).toBe(
      "kept as text"
    );
  });
});
