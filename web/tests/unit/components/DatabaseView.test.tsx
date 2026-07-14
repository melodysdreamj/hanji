// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
import { i18next } from "@/i18n";
import { useStore } from "@/lib/store";
import type { DbTemplate, DbView, Page } from "@/lib/types";
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

beforeEach(async () => {
  await i18next.changeLanguage("en");
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

    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-view-tab="v-board"]')!);

    expect(screen.getByRole("tab", { name: "Board" }).getAttribute("aria-selected")).toBe(
      "true"
    );
    expect(container.querySelector("[data-table-title-input]")).toBeNull();
    // Board columns come from the grouped select options.
    expect(screen.getByRole("button", { name: "Todo group actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done group actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Task one in Todo" })).toBeTruthy();
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
    expect(screen.getByRole("grid", { name: /July 2026 calendar/ })).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
    expect(
      screen.getByRole("button", { name: /Open Task one, scheduled for July 1, 2026/ })
    ).toBeTruthy();
  });

  it("renders the timeline chrome for an initial timeline view", () => {
    renderDatabase(ALL_VIEWS, { initialViewId: "v-timeline" });
    expect(screen.getByRole("group", { name: "Timeline zoom" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Open Task one, Jul 1, 2026 to Jul 1, 2026/ })
    ).toBeTruthy();
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

  it("preserves user-authored Untitled template name and page title literals", async () => {
    const db = seedDatabase([
      makeView(DB_ID, { id: "v-table", name: "Table", type: "table", position: 0 }),
    ]);
    const template: DbTemplate = {
      id: "template-literal",
      databaseId: DB_ID,
      name: "Untitled template",
      title: "Untitled",
      blocks: [{ type: "paragraph", content: { rich: [] } }],
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    useStore.setState({ templatesByDb: { [DB_ID]: [template] } });
    render(<DatabaseView db={db} skipRemoteLoad syncUrl={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose database template" }));
    expect(screen.getByText("Untitled template")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const title = await screen.findByRole("textbox", { name: "Template page title" });
    expect((title as HTMLInputElement).value).toBe("Untitled");
  });

  it("keeps the template editor modal isolated, cycles focus, and restores its trigger", async () => {
    const db = seedDatabase([makeView(DB_ID, { id: "v-table", name: "Table", type: "table", position: 0 })]);
    const template: DbTemplate = {
      id: "template-focus",
      databaseId: DB_ID,
      name: "Focus template",
      title: "Focus template",
      blocks: [{ type: "paragraph", content: { rich: [] } }],
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    useStore.setState({ templatesByDb: { [DB_ID]: [template] } });
    const { container } = render(
      <DatabaseView db={db} skipRemoteLoad syncUrl={false} />
    );

    const trigger = screen.getByRole("button", { name: "Choose database template" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const dialog = await screen.findByRole("dialog", { name: "Edit database template" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect((container as HTMLElement).inert).toBe(true);
    expect(container.getAttribute("aria-hidden")).toBe("true");

    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), ' +
          'select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], ' +
          '[tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (element) =>
        element.getAttribute("aria-hidden") !== "true" &&
        !element.closest('[aria-hidden="true"], [hidden]')
    );
    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    const blockActions = screen.getAllByRole("button", { name: "Open block actions" })[0];
    fireEvent.click(blockActions);
    const portaledMenu = screen.getByRole("menu");
    const portaledItems = Array.from(
      portaledMenu.querySelectorAll<HTMLElement>("[data-block-menu-item]")
    );
    expect(portaledItems.length).toBeGreaterThan(1);
    for (const item of portaledItems) {
      item.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
    }
    const portaledFirst = portaledItems[0];
    portaledFirst.focus();
    expect(portaledMenu.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(portaledFirst, { key: "Tab" });
    const portaledSecond = document.activeElement as HTMLElement;
    expect(portaledSecond).not.toBe(portaledFirst);
    fireEvent.keyDown(portaledSecond, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(portaledFirst);
    fireEvent.keyDown(portaledFirst, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.keyDown(first, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit database template" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect((container as HTMLElement).inert).not.toBe(true);
    expect(container.hasAttribute("aria-hidden")).toBe(false);
  });

  it("lets nested template pickers, previews, and menus consume Escape before the editor", async () => {
    const db = seedDatabase([makeView(DB_ID, { id: "v-table", name: "Table", type: "table", position: 0 })]);
    const template: DbTemplate = {
      id: "template-nested-escape",
      databaseId: DB_ID,
      name: "Nested template",
      title: "Nested template",
      blocks: [{ type: "image", content: { url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" } }],
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    useStore.setState({ templatesByDb: { [DB_ID]: [template] } });
    const { container } = render(<DatabaseView db={db} skipRemoteLoad syncUrl={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose database template" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("dialog", { name: "Edit database template" });

    fireEvent.click(screen.getByRole("button", { name: "Add template icon" }));
    expect(screen.getByRole("dialog", { name: "Choose icon" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search icons" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose icon" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Edit database template" })).toBe(editor);

    fireEvent.click(screen.getByRole("button", { name: "Open template actions" }));
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Edit database template" })).toBe(editor);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open template actions" }));

    const image = container.ownerDocument.querySelector<HTMLImageElement>(
      '[data-block-type="image"] img'
    );
    expect(image).toBeTruthy();
    fireEvent.doubleClick(image!);
    const preview = screen.getByRole("dialog", { name: "Image preview" });
    const closePreview = screen.getByRole("button", { name: "Close image preview" });
    await waitFor(() => expect(document.activeElement).toBe(closePreview));
    expect(editor.inert).toBe(true);
    expect(editor.getAttribute("aria-hidden")).toBe("true");
    fireEvent.keyDown(closePreview, { key: "Tab" });
    expect(document.activeElement).toBe(closePreview);
    fireEvent.keyDown(preview, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Edit database template" })).toBe(editor);
    expect(editor.inert).not.toBe(true);
    expect(editor.hasAttribute("aria-hidden")).toBe(false);
  });

  it("falls back to the remounted database toolbar when the original trigger disappears", async () => {
    const db = seedDatabase([
      makeView(DB_ID, { id: "v-table", name: "Table", type: "table", position: 0 }),
      makeView(DB_ID, { id: "v-board", name: "Board", type: "board", position: 1 }),
    ]);
    const template: DbTemplate = {
      id: "template-remount-focus", databaseId: DB_ID, name: "Remount",
      title: "Remount", position: 0,
    };
    useStore.setState({ templatesByDb: { [DB_ID]: [template] } });
    render(<DatabaseView db={db} skipRemoteLoad syncUrl={false} />);
    const oldTrigger = screen.getByRole("button", { name: "Choose database template" });
    fireEvent.click(oldTrigger);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("dialog", { name: "Edit database template" });

    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-view-tab="v-board"]')!);

    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "Edit database template" })
    ).toBeNull());
    expect(oldTrigger.isConnected).toBe(false);
    const newToolbar = document.querySelector<HTMLElement>(
      `[data-database-toolbar="${DB_ID}"]`
    );
    expect(newToolbar).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(newToolbar));
  });

  it.each([
    ["menu", false],
    ["menu", true],
    ["banner", false],
    ["banner", true],
  ] as const)(
    "restores focus after a %s duplicate when success=%s and hands successful copies to a new dialog",
    async (entryPoint, succeeds) => {
      const db = seedDatabase([makeView(DB_ID, { id: "v-table", name: "Table", type: "table", position: 0 })]);
      const template: DbTemplate = {
        id: `template-duplicate-${entryPoint}-${succeeds}`,
        databaseId: DB_ID,
        name: "Duplicate source",
        title: "Duplicate source",
        position: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      useStore.setState({
        templatesByDb: { [DB_ID]: [template] },
        duplicateTemplate: vi.fn(async () => {
          if (!succeeds) return null;
          const copy: DbTemplate = {
            ...template,
            id: `${template.id}-copy`,
            name: "Duplicate copy",
            title: "Copied title",
            position: 1,
          };
          useStore.setState({ templatesByDb: { [DB_ID]: [template, copy] } });
          return copy;
        }),
      });
      render(<DatabaseView db={db} skipRemoteLoad syncUrl={false} />);
      const trigger = screen.getByRole("button", { name: "Choose database template" });
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      await screen.findByRole("dialog", { name: "Edit database template" });

      if (entryPoint === "menu") {
        fireEvent.click(screen.getByRole("button", { name: "Open template actions" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
      }

      if (succeeds) {
        await waitFor(() =>
          expect((screen.getByLabelText("Template page title") as HTMLInputElement).value).toBe("Copied title")
        );
      } else {
        await waitFor(() =>
          expect(useStore.getState().toasts.some((toast) => toast.message === "Couldn't duplicate template")).toBe(true)
        );
      }
      fireEvent.click(
        document.querySelector<HTMLButtonElement>('[data-template-editor-close="true"]')!
      );
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit database template" })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    },
    10_000,
  );

  it("keeps template creation in the menu and avoids a false success after terminal rollback", async () => {
    const db = seedDatabase([makeView(DB_ID, { id: "v-table", name: "Table", type: "table", position: 0 })]);
    useStore.setState({ addTemplate: vi.fn(async () => null) });
    render(<DatabaseView db={db} skipRemoteLoad syncUrl={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Choose database template" }));
    const menu = screen.getByRole("dialog", { name: "New database page" });
    fireEvent.click(screen.getByRole("button", { name: "Create new database template" }));

    await waitFor(() => expect(
      useStore.getState().toasts.some((toast) => toast.message === "Couldn't create template")
    ).toBe(true));
    expect(screen.getByRole("dialog", { name: "New database page" })).toBe(menu);
    expect(screen.queryByRole("dialog", { name: "Edit database template" })).toBeNull();
    expect(useStore.getState().toasts.some((toast) => toast.message === "Created template")).toBe(false);
  });

  it.each([false, true])(
    "closes the template editor for page handoff only when template use succeeds (success=%s)",
    async (succeeds) => {
      const db = seedDatabase([makeView(DB_ID, { id: "v-table", name: "Table", type: "table", position: 0 })]);
      const template: DbTemplate = {
        id: `template-use-${succeeds}`,
        databaseId: DB_ID,
        name: "Use source",
        title: "Use source",
        blocks: [{ type: "paragraph", content: { rich: [] } }],
        position: 0,
      };
      useStore.setState({
        templatesByDb: { [DB_ID]: [template] },
        addRow: vi.fn(async () => {
          if (!succeeds) throw new Error("terminal row create failure");
          return makeRow(DB_ID, { id: "created-from-template", properties: {}, position: 3 });
        }),
      });
      render(<DatabaseView db={db} skipRemoteLoad syncUrl={false} />);
      const trigger = screen.getByRole("button", { name: "Choose database template" });
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      await screen.findByRole("dialog", { name: "Edit database template" });
      fireEvent.click(screen.getByRole("button", { name: "Open template actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Create new page" }));

      if (succeeds) {
        await waitFor(() => expect(
          screen.queryByRole("dialog", { name: "Edit database template" })
        ).toBeNull());
      } else {
        await waitFor(() => expect(
          useStore.getState().toasts.some(
            (toast) => toast.message === "Couldn't create a page from this template"
          )
        ).toBe(true));
        expect(screen.getByRole("dialog", { name: "Edit database template" })).toBeTruthy();
        await waitFor(() => expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Open template actions" })
        ));
        expect(useStore.getState().toasts.some((toast) => toast.message === "Created template")).toBe(false);
      }
    },
    10_000,
  );

  it("renders the complete database view controls in Korean", async () => {
    await i18next.changeLanguage("ko");
    renderDatabase(ALL_VIEWS);

    const addView = screen.getByRole("button", { name: "보기 추가" });
    fireEvent.click(addView);
    const addDialog = screen.getByRole("dialog", { name: "새 보기 추가" });
    expect(screen.getByText("데이터베이스를 표시할 방식을 선택하세요.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /표.*구조화된 데이터를 행과 열로 표시합니다/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "취소" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "만들기" })).toBeTruthy();
    fireEvent.keyDown(addDialog, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "필터" }));
    const filterDialog = screen.getByRole("dialog", { name: "필터" });
    expect(screen.getByText("규칙과 일치하는 행만 표시합니다.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "필터 추가" }));
    expect(screen.getByLabelText("필터 속성")).toBeTruthy();
    expect(screen.getByLabelText("필터 조건")).toBeTruthy();
    fireEvent.keyDown(filterDialog, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "정렬" }));
    expect(screen.getByText("속성을 기준으로 행 순서를 정합니다.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "정렬 추가" }));
    expect(screen.getByLabelText("정렬 속성")).toBeTruthy();
    expect(screen.getByLabelText("정렬 방향")).toBeTruthy();
  });
});
