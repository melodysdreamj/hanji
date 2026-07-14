// @vitest-environment jsdom
//
// Destructive/result-driven optimistic actions remain fail-closed. Creation
// actions with complete client ids return immediately, then reconcile or roll
// back a terminal background result without holding the UI handoff hostage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("authoritative bootstrap unavailable in focused test");
    }),
    createPropertyRemote: vi.fn(async (property) => property),
    createTemplateRemote: vi.fn(async (template) => template),
    createViewRemote: vi.fn(async (view) => view),
    deleteTemplateRemote: vi.fn(async () => undefined),
    deleteViewRemote: vi.fn(async () => undefined),
    getDatabaseSnapshotRemote: vi.fn(async () => {
      throw new Error("authoritative database reload unavailable in focused test");
    }),
    restorePageRemote: vi.fn(async () => []),
    trashPageRemote: vi.fn(async () => []),
    updatePageRemote: vi.fn(async () => undefined),
    updatePropertyRemote: vi.fn(async () => undefined),
    updateTemplateRemote: vi.fn(async () => undefined),
    updateViewRemote: vi.fn(async () => undefined),
  };
});

import {
  createPropertyRemote,
  createTemplateRemote,
  createViewRemote,
  deleteTemplateRemote,
  deleteViewRemote,
  restorePageRemote,
  trashPageRemote,
  updatePageRemote,
  updatePropertyRemote,
  updateTemplateRemote,
  updateViewRemote,
} from "@/lib/edgebase";
import { useStore, type DeletedPropertyOptionSnapshot } from "@/lib/store";
import type { DbTemplate, DbView } from "@/lib/types";
import {
  makePage,
  makeProp,
  makeRow,
  resetStore,
  seedPages,
  seedUser,
  TEST_USER,
} from "./components/storeTestUtils";

const NOW = new Date(0).toISOString();

function terminal(status = 400) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function offline() {
  return new Error("network down");
}

function view(id = "view-1", overrides: Partial<DbView> = {}): DbView {
  return {
    id,
    databaseId: "db",
    name: id,
    type: "table",
    position: 1,
    createdAt: NOW,
    updatedAt: NOW,
    config: {},
    ...overrides,
  };
}

function template(id = "template-1", overrides: Partial<DbTemplate> = {}): DbTemplate {
  return {
    id,
    databaseId: "db",
    name: id,
    title: "",
    properties: {},
    blocks: [],
    isDefault: false,
    position: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function seedDatabase() {
  const database = makePage({ id: "db", kind: "database", title: "Database" });
  const row = makeRow(database.id, {
    id: "row-1",
    title: "Row",
    properties: { option: "opt-1", other: "keep" },
  });
  const title = makeProp(database.id, { id: "title", type: "title", name: "Name" });
  const option = makeProp(database.id, {
    id: "option",
    type: "select",
    name: "Status",
    config: { options: [{ id: "opt-1", name: "One", color: "blue" }] },
  });
  const baseView = view("view-1", {
    config: { propertyOrder: [title.id, option.id], visibleProperties: [title.id, option.id] },
  });
  const baseTemplate = template("template-1");
  seedPages([database, row]);
  useStore.setState((state) => ({
    workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
    pageRolesById: { ...state.pageRolesById, [database.id]: "edit", [row.id]: "edit" },
    propsByDb: { ...state.propsByDb, [database.id]: [title, option] },
    viewsByDb: { ...state.viewsByDb, [database.id]: [baseView] },
    templatesByDb: { ...state.templatesByDb, [database.id]: [baseTemplate] },
    databaseRowIdsByDb: { ...state.databaseRowIdsByDb, [database.id]: [row.id] },
  }));
  return { baseTemplate, baseView, database, option, row, title };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetStore();
  seedUser();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("page lifecycle durable outcomes", () => {
  function seedTree(inTrash: boolean) {
    const root = makePage({
      id: "root",
      title: "Root",
      inTrash,
      trashedAt: inTrash ? NOW : null,
    });
    const child = makePage({
      id: "child",
      parentId: root.id,
      parentType: "page",
      title: "Child",
      inTrash,
      trashedAt: inTrash ? NOW : null,
    });
    seedPages([root, child]);
    useStore.setState({
      workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
      focusPageId: root.id,
    });
    return { child, root };
  }

  it("trash: dropped restores the whole optimistic subtree and rejects", async () => {
    const { child, root } = seedTree(false);
    vi.mocked(trashPageRemote).mockRejectedValueOnce(terminal(403));

    await expect(useStore.getState().trashPage(root.id)).rejects.toMatchObject({ status: 403 });

    expect(useStore.getState().pagesById[root.id]?.inTrash).toBe(false);
    expect(useStore.getState().pagesById[child.id]?.inTrash).toBe(false);
    expect(useStore.getState().focusPageId).toBe(root.id);
  });

  it("trash: queued and ok retain the optimistic subtree", async () => {
    let fixture = seedTree(false);
    vi.mocked(trashPageRemote).mockRejectedValueOnce(offline());
    await expect(useStore.getState().trashPage(fixture.root.id)).resolves.toBeUndefined();
    expect(useStore.getState().pagesById[fixture.child.id]?.inTrash).toBe(true);

    resetStore();
    seedUser();
    fixture = seedTree(false);
    vi.mocked(trashPageRemote).mockResolvedValueOnce([] as never);
    await expect(useStore.getState().trashPage(fixture.root.id)).resolves.toBeUndefined();
    expect(useStore.getState().pagesById[fixture.child.id]?.inTrash).toBe(true);
  });

  it("restore: dropped re-trashes the subtree; queued and ok keep it restored", async () => {
    let fixture = seedTree(true);
    vi.mocked(restorePageRemote).mockRejectedValueOnce(terminal(400));
    await expect(useStore.getState().restorePage(fixture.root.id)).rejects.toMatchObject({
      status: 400,
    });
    expect(useStore.getState().pagesById[fixture.root.id]?.inTrash).toBe(true);
    expect(useStore.getState().pagesById[fixture.child.id]?.inTrash).toBe(true);

    resetStore();
    seedUser();
    fixture = seedTree(true);
    vi.mocked(restorePageRemote).mockRejectedValueOnce(offline());
    await useStore.getState().restorePage(fixture.root.id);
    expect(useStore.getState().pagesById[fixture.child.id]?.inTrash).toBe(false);

    resetStore();
    seedUser();
    fixture = seedTree(true);
    vi.mocked(restorePageRemote).mockResolvedValueOnce([] as never);
    await useStore.getState().restorePage(fixture.root.id);
    expect(useStore.getState().pagesById[fixture.child.id]?.inTrash).toBe(false);
  });
});

describe("database property durable outcomes", () => {
  it("addProperty returns immediately, then removes a terminal phantom and retains queued/ok", async () => {
    seedDatabase();
    vi.mocked(createPropertyRemote).mockRejectedValueOnce(terminal(403));
    const dropped = await useStore.getState().addProperty("db", "text", "Dropped");
    expect(dropped?.name).toBe("Dropped");
    expect(createPropertyRemote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(useStore.getState().dbProperties("db").some((item) => item.name === "Dropped")).toBe(false);

    resetStore();
    seedUser();
    seedDatabase();
    vi.mocked(createPropertyRemote).mockRejectedValueOnce(offline());
    const queued = await useStore.getState().addProperty("db", "text", "Queued");
    expect(queued?.name).toBe("Queued");
    expect(useStore.getState().dbProperties("db")).toContainEqual(queued);
    await vi.advanceTimersByTimeAsync(2000);

    resetStore();
    seedUser();
    seedDatabase();
    vi.mocked(createPropertyRemote).mockResolvedValueOnce({} as never);
    const ok = await useStore.getState().addProperty("db", "text", "OK");
    expect(ok?.name).toBe("OK");
    await vi.advanceTimersByTimeAsync(0);
  });

  it("keeps the property but removes invalid view references when a dependent view write drops", async () => {
    const { baseView } = seedDatabase();
    vi.mocked(updateViewRemote).mockRejectedValueOnce(terminal(400));

    await expect(useStore.getState().addProperty("db", "text", "Partial")).resolves.toMatchObject({
      name: "Partial",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(useStore.getState().dbProperties("db").some((item) => item.name === "Partial")).toBe(true);
    expect(useStore.getState().dbViews("db")[0]?.config).toEqual(baseView.config);
  });

  it("option delete is fail-closed until the backend owns a complete row cascade", async () => {
    const fixture = seedDatabase();
    await expect(
      useStore.getState().deletePropertyOption(fixture.option.id, "opt-1")
    ).resolves.toBeNull();
    expect(useStore.getState().pagesById[fixture.row.id]?.properties).toEqual(
      fixture.row.properties
    );
    expect(useStore.getState().dbProperties("db")[1]?.config?.options).toHaveLength(1);
    expect(updatePropertyRemote).not.toHaveBeenCalled();
    expect(updatePageRemote).not.toHaveBeenCalled();
  });

  it("option delete never mutates even when remote mocks are configured", async () => {
    const fixture = seedDatabase();
    vi.mocked(updatePageRemote).mockRejectedValueOnce(terminal(400));

    await expect(
      useStore.getState().deletePropertyOption(fixture.option.id, "opt-1")
    ).resolves.toBeNull();

    expect(useStore.getState().dbProperties("db")[1]?.config?.options).toEqual(
      fixture.option.config?.options
    );
    expect(useStore.getState().pagesById[fixture.row.id]?.properties).toEqual(
      fixture.row.properties
    );
  });

  it("option restore is fail-closed and leaves local state untouched", async () => {
    const snapshot: DeletedPropertyOptionSnapshot = {
      dbId: "db",
      propertyId: "option",
      option: { id: "opt-1", name: "One", color: "blue" },
      optionIndex: 0,
      rows: [{ id: "row-1", value: "opt-1" }],
    };
    const seedDeleted = () => {
      const fixture = seedDatabase();
      useStore.setState((state) => ({
        pagesById: {
          ...state.pagesById,
          [fixture.row.id]: {
            ...state.pagesById[fixture.row.id]!,
            properties: { option: null, other: "newer" },
          },
        },
        propsByDb: {
          ...state.propsByDb,
          db: state.propsByDb.db.map((prop) =>
            prop.id === "option" ? { ...prop, config: { options: [] } } : prop
          ),
        },
      }));
    };

    seedDeleted();
    await expect(useStore.getState().restoreDeletedPropertyOption(snapshot)).resolves.toBe(false);
    expect(useStore.getState().pagesById["row-1"]?.properties).toEqual({
      option: null,
      other: "newer",
    });
    expect(useStore.getState().dbProperties("db")[1]?.config?.options).toEqual([]);

    expect(updatePropertyRemote).not.toHaveBeenCalled();
    expect(updatePageRemote).not.toHaveBeenCalled();
  });
});

describe("database view durable outcomes", () => {
  it("addView returns immediately, then removes on dropped and retains queued/ok", async () => {
    seedDatabase();
    vi.mocked(createViewRemote).mockRejectedValueOnce(terminal(403));
    const dropped = await useStore.getState().addView("db", "board", "Dropped");
    expect(dropped?.name).toBe("Dropped");
    expect(createViewRemote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(useStore.getState().dbViews("db").some((item) => item.name === "Dropped")).toBe(false);

    resetStore();
    seedUser();
    seedDatabase();
    vi.mocked(createViewRemote).mockRejectedValueOnce(offline());
    const queued = await useStore.getState().addView("db", "board", "Queued");
    expect(queued?.name).toBe("Queued");
    await vi.advanceTimersByTimeAsync(2000);

    resetStore();
    seedUser();
    seedDatabase();
    const ok = await useStore.getState().addView("db", "board", "OK");
    expect(ok?.name).toBe("OK");
    await vi.advanceTimersByTimeAsync(0);
  });

  it("deleteView returns null/restores on dropped; queued and ok return the snapshot", async () => {
    seedDatabase();
    vi.mocked(deleteViewRemote).mockRejectedValueOnce(terminal(400));
    await expect(useStore.getState().deleteView("view-1")).resolves.toBeNull();
    expect(useStore.getState().dbViews("db").map((item) => item.id)).toContain("view-1");

    resetStore();
    seedUser();
    seedDatabase();
    vi.mocked(deleteViewRemote).mockRejectedValueOnce(offline());
    const queued = await useStore.getState().deleteView("view-1");
    expect(queued?.id).toBe("view-1");
    expect(useStore.getState().dbViews("db")).toHaveLength(0);

    resetStore();
    seedUser();
    seedDatabase();
    const ok = await useStore.getState().deleteView("view-1");
    expect(ok?.id).toBe("view-1");
  });

  it("restoreDeletedView is false/removes on dropped and true/retained for queued/ok", async () => {
    const seedMissing = () => {
      const fixture = seedDatabase();
      useStore.setState((state) => ({
        viewsByDb: { ...state.viewsByDb, db: [] },
      }));
      return fixture.baseView;
    };

    let snapshot = seedMissing();
    vi.mocked(createViewRemote).mockRejectedValueOnce(terminal(400));
    await expect(useStore.getState().restoreDeletedView(snapshot)).resolves.toBe(false);
    expect(useStore.getState().dbViews("db")).toHaveLength(0);

    resetStore();
    seedUser();
    snapshot = seedMissing();
    vi.mocked(createViewRemote).mockRejectedValueOnce(offline());
    await expect(useStore.getState().restoreDeletedView(snapshot)).resolves.toBe(true);
    expect(useStore.getState().dbViews("db")).toContainEqual(snapshot);

    resetStore();
    seedUser();
    snapshot = seedMissing();
    await expect(useStore.getState().restoreDeletedView(snapshot)).resolves.toBe(true);
  });
});

describe("database template durable outcomes", () => {
  it("preserves user-authored Untitled literals when duplicating a template", async () => {
    seedDatabase();
    const literal = template("literal", {
      name: "Untitled template",
      title: "Untitled",
      position: 2,
    });
    useStore.setState((state) => ({
      templatesByDb: { ...state.templatesByDb, db: [literal] },
    }));

    const copy = await useStore.getState().duplicateTemplate(literal.id);

    expect(copy?.name).toContain("Untitled template");
    expect(copy?.title).toBe("Untitled");
    await vi.advanceTimersByTimeAsync(0);
  });

  it("deleteTemplate returns null/restores on dropped; queued and ok return the snapshot", async () => {
    seedDatabase();
    vi.mocked(deleteTemplateRemote).mockRejectedValueOnce(terminal(400));
    await expect(useStore.getState().deleteTemplate("template-1")).resolves.toBeNull();
    expect(useStore.getState().dbTemplates("db").map((item) => item.id)).toContain("template-1");

    resetStore();
    seedUser();
    seedDatabase();
    vi.mocked(deleteTemplateRemote).mockRejectedValueOnce(offline());
    const queued = await useStore.getState().deleteTemplate("template-1");
    expect(queued?.id).toBe("template-1");
    expect(useStore.getState().dbTemplates("db")).toHaveLength(0);

    resetStore();
    seedUser();
    seedDatabase();
    const ok = await useStore.getState().deleteTemplate("template-1");
    expect(ok?.id).toBe("template-1");
  });

  it("restoreDeletedTemplate is false/rolled back on dropped and true for queued/ok", async () => {
    const seedMissing = () => {
      seedDatabase();
      const oldDefault = template("old-default", { isDefault: true, position: 0 });
      const restored = template("restore", { isDefault: true, position: 2 });
      useStore.setState((state) => ({
        templatesByDb: { ...state.templatesByDb, db: [oldDefault] },
      }));
      return { oldDefault, restored };
    };

    let fixture = seedMissing();
    vi.mocked(createTemplateRemote).mockRejectedValueOnce(terminal(400));
    await expect(
      useStore.getState().restoreDeletedTemplate(fixture.restored)
    ).resolves.toBe(false);
    expect(useStore.getState().dbTemplates("db")).toEqual([fixture.oldDefault]);

    resetStore();
    seedUser();
    fixture = seedMissing();
    vi.mocked(createTemplateRemote).mockRejectedValueOnce(offline());
    await expect(
      useStore.getState().restoreDeletedTemplate(fixture.restored)
    ).resolves.toBe(true);
    expect(useStore.getState().dbTemplates("db").find((item) => item.id === "restore")?.isDefault).toBe(true);

    resetStore();
    seedUser();
    fixture = seedMissing();
    await expect(
      useStore.getState().restoreDeletedTemplate(fixture.restored)
    ).resolves.toBe(true);
  });

  it("updateTemplate blocks success and restores a previous default whose secondary write drops", async () => {
    seedDatabase();
    const selected = template("selected", { isDefault: false, position: 2 });
    const previous = template("previous", { isDefault: true, position: 1 });
    useStore.setState((state) => ({
      templatesByDb: { ...state.templatesByDb, db: [previous, selected] },
    }));
    vi.mocked(updateTemplateRemote).mockImplementation(async (id) => {
      if (id === previous.id) throw terminal(400);
      return undefined;
    });

    await expect(
      useStore.getState().updateTemplate(selected.id, { isDefault: true })
    ).resolves.toBe(false);

    expect(useStore.getState().dbTemplates("db").find((item) => item.id === selected.id)?.isDefault).toBe(true);
    expect(useStore.getState().dbTemplates("db").find((item) => item.id === previous.id)?.isDefault).toBe(true);
  });
});
