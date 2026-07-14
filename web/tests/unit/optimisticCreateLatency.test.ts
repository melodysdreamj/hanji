// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    createCommentRemote: vi.fn(async (comment) => comment),
    createDatabaseRemote: vi.fn(),
    createDatabaseRowRemote: vi.fn(),
    createPropertyRemote: vi.fn(async (property) => property),
    createTemplateRemote: vi.fn(async (template) => template),
    createViewRemote: vi.fn(async (view) => view),
    updateCommentRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updatePageRemote: vi.fn(async () => undefined),
    updatePropertyRemote: vi.fn(async () => undefined),
    updateTemplateRemote: vi.fn(async () => undefined),
    updateViewRemote: vi.fn(async () => undefined),
  };
});

import {
  createCommentRemote,
  createDatabaseRemote,
  createDatabaseRowRemote,
  createPropertyRemote,
  createTemplateRemote,
  createViewRemote,
  updateCommentRemote,
  updateDatabaseRowRemote,
  updatePageRemote,
  updatePropertyRemote,
  updateTemplateRemote,
  updateViewRemote,
} from "@/lib/edgebase";
import type { CreateDatabaseResult } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import type { Comment, DbProperty, DbTemplate, DbView, Page } from "@/lib/types";
import {
  makePage,
  makeProp,
  resetStore,
  seedPages,
  seedUser,
  TEST_USER,
} from "./components/storeTestUtils";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function terminal(status = 403) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function seedDatabase() {
  const db = makePage({ id: "db", kind: "database", title: "Database" });
  const title = makeProp(db.id, { id: "title", type: "title", name: "Name" });
  const view: DbView = {
    id: "view",
    databaseId: db.id,
    name: "Table",
    type: "table",
    position: 1,
    config: { propertyOrder: [title.id], visibleProperties: [title.id] },
  };
  seedPages([db]);
  useStore.setState((state) => ({
    pageRolesById: { ...state.pageRolesById, [db.id]: "edit" },
    propsByDb: { ...state.propsByDb, [db.id]: [title] },
    viewsByDb: { ...state.viewsByDb, [db.id]: [view] },
    templatesByDb: { ...state.templatesByDb, [db.id]: [] },
    databaseRowIdsByDb: { ...state.databaseRowIdsByDb, [db.id]: [] },
    loadedDbs: new Set(state.loadedDbs).add(db.id),
  }));
  return { db, title, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetStore();
  seedUser();
  useStore.setState({
    workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
  });
});

afterEach(() => {
  resetStore();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("optimistic create UI handoffs", () => {
  it("returns a database row before I/O and holds property writes behind its create", async () => {
    const gate = deferred<{ row: Page; blocks: [] }>();
    vi.mocked(createDatabaseRowRemote).mockImplementationOnce(() => gate.promise);
    seedDatabase();

    const row = await useStore.getState().addRow("db", true, undefined, { focusTitle: true });
    expect(useStore.getState().pagesById[row.id]).toEqual(row);
    expect(useStore.getState().focusPageId).toBe(row.id);
    expect(createDatabaseRowRemote).not.toHaveBeenCalled();

    useStore.getState().updatePage(row.id, { properties: { status: "ready" } });
    expect(updateDatabaseRowRemote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(createDatabaseRowRemote).toHaveBeenCalledTimes(1);
    expect(updateDatabaseRowRemote).not.toHaveBeenCalled();

    gate.resolve({ row, blocks: [] });
    await settle();
    expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(1);
  });

  it("returns and activates a view locally while its update waits for create", async () => {
    const gate = deferred<DbView>();
    vi.mocked(createViewRemote).mockImplementationOnce(() => gate.promise);
    seedDatabase();

    const view = await useStore.getState().addView("db", "board", "Board");
    expect(view?.name).toBe("Board");
    expect(createViewRemote).not.toHaveBeenCalled();
    useStore.getState().updateView(view!.id, { name: "Renamed" });
    expect(updateViewRemote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(createViewRemote).toHaveBeenCalledTimes(1);
    gate.resolve(view!);
    await settle();
    expect(updateViewRemote).toHaveBeenCalledTimes(1);
  });

  it("returns a property locally while view/property writes wait for create", async () => {
    const gate = deferred<DbProperty>();
    vi.mocked(createPropertyRemote).mockImplementationOnce(() => gate.promise);
    const { view } = seedDatabase();

    const property = await useStore.getState().addProperty("db", "date", "Date");
    expect(property?.name).toBe("Date");
    useStore.getState().updateProperty(property!.id, { name: "Due" });
    useStore.getState().updateView(view.id, {
      config: { ...view.config, calendarBy: property!.id },
    });
    expect(createPropertyRemote).not.toHaveBeenCalled();
    expect(updatePropertyRemote).not.toHaveBeenCalled();
    expect(updateViewRemote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    gate.resolve(property!);
    await settle();
    expect(updatePropertyRemote).toHaveBeenCalledTimes(1);
    expect(updateViewRemote).toHaveBeenCalled();
  });

  it("returns a template locally while edits wait for create", async () => {
    const gate = deferred<DbTemplate>();
    vi.mocked(createTemplateRemote).mockImplementationOnce(() => gate.promise);
    seedDatabase();

    const template = await useStore.getState().addTemplate("db", "Template");
    expect(template?.name).toBe("Template");
    await useStore.getState().updateTemplate(template!.id, { title: "Draft" });
    expect(createTemplateRemote).not.toHaveBeenCalled();
    expect(updateTemplateRemote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    gate.resolve(template!);
    await settle();
    expect(updateTemplateRemote).toHaveBeenCalledTimes(1);
  });

  it("returns a comment locally and releases composer-followup edits after create", async () => {
    const gate = deferred<Comment>();
    vi.mocked(createCommentRemote).mockImplementationOnce(() => gate.promise);
    const page = makePage({ id: "page", title: "Page" });
    seedPages([page]);
    useStore.setState((state) => ({
      pageRolesById: { ...state.pageRolesById, [page.id]: "edit" },
    }));

    const comment = await useStore.getState().addComment(page.id, "Hello");
    expect(useStore.getState().pageComments(page.id)).toContainEqual(comment);
    useStore.getState().updateComment(comment.id, { resolved: true });
    expect(createCommentRemote).not.toHaveBeenCalled();
    expect(updateCommentRemote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    gate.resolve(comment);
    await settle();
    expect(updateCommentRemote).toHaveBeenCalledTimes(1);
  });

  it("returns a renderable database before I/O and holds page writes behind atomic create", async () => {
    const gate = deferred<CreateDatabaseResult>();
    vi.mocked(createDatabaseRemote).mockImplementationOnce(() => gate.promise);

    const database = await useStore.getState().createDatabase({
      parentId: null,
      parentType: "workspace",
      seedRows: false,
      title: "Immediate database",
      viewType: "table",
    });
    expect(createDatabaseRemote).not.toHaveBeenCalled();
    expect(useStore.getState().dbProperties(database.id).length).toBeGreaterThan(0);
    expect(useStore.getState().dbViews(database.id)).toHaveLength(1);
    useStore.getState().updatePage(database.id, { title: "Renamed immediately" });
    expect(updatePageRemote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    const state = useStore.getState();
    gate.resolve({
      page: database,
      properties: state.dbProperties(database.id),
      views: state.dbViews(database.id),
      templates: [],
      rows: [],
    });
    await settle();
    expect(updatePageRemote).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pagesById[database.id]?.title).toBe("Renamed immediately");
  });

  it("removes a terminally rejected row and clears its pending focus", async () => {
    vi.mocked(createDatabaseRowRemote).mockRejectedValueOnce(terminal());
    seedDatabase();

    const row = await useStore.getState().addRow("db", true, undefined, { focusTitle: true });
    expect(useStore.getState().pagesById[row.id]).toBeDefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(useStore.getState().pagesById[row.id]).toBeUndefined();
    expect(useStore.getState().databaseRowIdsByDb.db).not.toContain(row.id);
    expect(useStore.getState().focusPageId).toBeUndefined();
  });

  it("removes a terminally rejected comment together with its waiting reply", async () => {
    vi.mocked(createCommentRemote).mockRejectedValueOnce(terminal());
    const page = makePage({ id: "page", title: "Page" });
    seedPages([page]);
    useStore.setState((state) => ({
      pageRolesById: { ...state.pageRolesById, [page.id]: "edit" },
    }));

    const parent = await useStore.getState().addComment(page.id, "Parent");
    const reply = await useStore.getState().addComment(page.id, "Reply", null, parent.id);
    expect(useStore.getState().pageComments(page.id).map((comment) => comment.id)).toEqual([
      parent.id,
      reply.id,
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(useStore.getState().pageComments(page.id)).toEqual([]);
    expect(createCommentRemote).toHaveBeenCalledTimes(1);
  });

  it("removes an optimistic database and any child row when atomic create is denied", async () => {
    vi.mocked(createDatabaseRemote).mockRejectedValueOnce(terminal());
    const database = await useStore.getState().createDatabase({
      parentId: null,
      parentType: "workspace",
      seedRows: false,
      title: "Rejected database",
      viewType: "table",
    });
    const row = await useStore.getState().addRow(database.id, true, undefined, {
      focusTitle: true,
    });
    expect(useStore.getState().pagesById[database.id]).toBeDefined();
    expect(useStore.getState().pagesById[row.id]).toBeDefined();

    await vi.advanceTimersByTimeAsync(0);

    expect(useStore.getState().pagesById[database.id]).toBeUndefined();
    expect(useStore.getState().pagesById[row.id]).toBeUndefined();
    expect(createDatabaseRowRemote).not.toHaveBeenCalled();
  });
});
