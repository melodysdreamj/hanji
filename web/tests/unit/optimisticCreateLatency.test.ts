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
    deletePropertyRemote: vi.fn(async () => undefined),
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
  deletePropertyRemote,
  updateCommentRemote,
  updateDatabaseRowRemote,
  updatePageRemote,
  updatePropertyRemote,
  updateTemplateRemote,
  updateViewRemote,
} from "@/lib/edgebase";
import type { CreateDatabaseResult } from "@/lib/edgebase";
import { databaseRowsQueryKey, useStore } from "@/lib/store";
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

function seedRelatedDatabase() {
  const db = makePage({ id: "related-db", kind: "database", title: "Related" });
  const title = makeProp(db.id, { id: "related-title", type: "title", name: "Name" });
  const view: DbView = {
    id: "related-view",
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

  it("orders reciprocal and rollup property creates behind their pending property ids", async () => {
    const sourceGate = deferred<DbProperty>();
    const reciprocalGate = deferred<DbProperty>();
    const rollupGate = deferred<DbProperty>();
    vi.mocked(createPropertyRemote)
      .mockImplementationOnce(() => sourceGate.promise)
      .mockImplementationOnce(() => reciprocalGate.promise)
      .mockImplementationOnce(() => rollupGate.promise);
    seedDatabase();
    const related = seedRelatedDatabase();

    const relation = await useStore.getState().addProperty("db", "relation", "Related", {
      relationDatabaseId: related.db.id,
    });
    expect(relation).toBeTruthy();
    await useStore.getState().setRelationTwoWay(relation!.id, true, "Projects");
    const reciprocal = useStore
      .getState()
      .dbProperties(related.db.id)
      .find((property) => property.config?.relatedPropertyId === relation!.id);
    expect(reciprocal).toBeTruthy();

    const rollup = await useStore.getState().addProperty("db", "rollup", "Related count", {
      rollupRelationPropertyId: relation!.id,
      rollupTargetPropertyId: related.title.id,
      rollupFunction: "count_all",
    });
    expect(rollup).toBeTruthy();

    await vi.advanceTimersByTimeAsync(0);
    expect(createPropertyRemote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createPropertyRemote).mock.calls[0]?.[0]).toMatchObject({
      id: relation!.id,
    });
    expect(updatePropertyRemote).not.toHaveBeenCalled();

    sourceGate.resolve(relation!);
    await settle();
    expect(createPropertyRemote).toHaveBeenCalledTimes(3);
    expect(vi.mocked(createPropertyRemote).mock.calls[1]?.[0]).toMatchObject({
      id: reciprocal!.id,
    });
    expect(vi.mocked(createPropertyRemote).mock.calls[2]?.[0]).toMatchObject({
      id: rollup!.id,
    });
    expect(updatePropertyRemote).not.toHaveBeenCalled();

    reciprocalGate.resolve(reciprocal!);
    rollupGate.resolve(rollup!);
    await settle();
    expect(updatePropertyRemote).toHaveBeenCalledWith(
      relation!.id,
      expect.objectContaining({
        config: expect.objectContaining({ relatedPropertyId: reciprocal!.id }),
      }),
      "db"
    );
  });

  it("repoints a paired relation with one retryable source update", async () => {
    seedDatabase();
    const related = seedRelatedDatabase();
    const relation = makeProp("db", {
      id: "source-relation",
      type: "relation",
      name: "Related",
      config: {
        relationDatabaseId: related.db.id,
        relatedPropertyId: "reciprocal-relation",
      },
    });
    const reciprocal = makeProp(related.db.id, {
      id: "reciprocal-relation",
      type: "relation",
      name: "Database",
      config: { relationDatabaseId: "db", relatedPropertyId: relation.id },
    });
    useStore.setState((state) => ({
      propsByDb: {
        ...state.propsByDb,
        db: [...(state.propsByDb.db ?? []), relation],
        [related.db.id]: [...(state.propsByDb[related.db.id] ?? []), reciprocal],
      },
    }));

    await useStore.getState().setRelationDatabase(relation.id, "new-target-db");

    expect(updatePropertyRemote).toHaveBeenCalledTimes(1);
    expect(updatePropertyRemote).toHaveBeenCalledWith(
      relation.id,
      {
        config: expect.objectContaining({
          relationDatabaseId: "new-target-db",
          relatedPropertyId: undefined,
        }),
      },
      "db",
      reciprocal.id
    );
    expect(deletePropertyRemote).not.toHaveBeenCalled();
    expect(
      useStore.getState().dbProperties(related.db.id).some((property) => property.id === reciprocal.id)
    ).toBe(false);
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
    const parent = makePage({ id: "inline-parent", title: "Parent" });
    seedPages([parent]);

    const database = await useStore.getState().createDatabase({
      parentId: parent.id,
      parentType: "page",
      seedRows: false,
      title: "Immediate database",
      viewType: "table",
    });
    expect(createDatabaseRemote).not.toHaveBeenCalled();
    expect(useStore.getState().dbProperties(database.id).length).toBeGreaterThan(0);
    expect(useStore.getState().dbViews(database.id)).toHaveLength(1);
    const viewId = useStore.getState().dbViews(database.id)[0]!.id;
    const activeRowsQuery = { viewId, currentPageId: parent.id, limit: 50 };
    await useStore.getState().loadDatabaseRows(database.id, {
      ...activeRowsQuery,
      reset: true,
    });
    expect(useStore.getState().databaseRowPagesByDb[database.id]).toMatchObject({
      queryKey: databaseRowsQueryKey(activeRowsQuery),
      loadedCount: 0,
      totalCount: 0,
      hasMore: false,
      loading: false,
      loadingMore: false,
    });
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
