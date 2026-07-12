// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  cacheGetMeta,
  cacheListTable,
  cacheReplaceTable,
  cacheSetMeta,
  clearOfflineWorkspaceFileCache,
  recordCacheClear,
  recordCacheIdle,
} = vi.hoisted(() => ({
  cacheGetMeta: vi.fn(async () => undefined),
  cacheListTable: vi.fn(async () => []),
  cacheReplaceTable: vi.fn(),
  cacheSetMeta: vi.fn(),
  clearOfflineWorkspaceFileCache: vi.fn(async () => undefined),
  recordCacheClear: vi.fn(async () => true),
  recordCacheIdle: vi.fn(async () => undefined),
}));

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in store permission test.");
    }),
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    createDatabaseRemote: vi.fn(async (
      input: Parameters<typeof actual.createDatabaseRemote>[0]
    ) => ({
      page: {
        id: input.id ?? "created-db",
        workspaceId: input.workspaceId,
        parentId: input.parentId ?? null,
        parentType: input.parentType ?? "workspace",
        kind: "database",
        title: input.title ?? "",
        position: 1,
      },
      properties: [],
      views: [],
      templates: [],
      rows: [],
    })),
    createTemplateRemote: vi.fn(async () => undefined),
    createPropertyRemote: vi.fn(async (
      property: Parameters<typeof actual.createPropertyRemote>[0]
    ) => property as DbProperty),
    deletePropertyRemote: vi.fn(async () => undefined),
    getDatabaseSnapshotRemote: vi.fn(async () => ({ properties: [], views: [], templates: [] })),
    getDatabaseRowsRemote: vi.fn(async () => ({ rows: [], hasMore: false, nextCursor: null })),
    updatePropertyRemote: vi.fn(async () => undefined),
    updateTemplateRemote: vi.fn(async () => undefined),
    updateViewRemote: vi.fn(async () => undefined),
    duplicatePageRemote: vi.fn(async (id: string) => ({
      page: {
        id: `${id}-copy`, workspaceId: "ws-1", parentId: null, parentType: "workspace",
        kind: "page", title: "Copy", position: 2,
      },
      pages: [], blocks: [], properties: [], views: [], templates: [], rows: [],
    })),
    deletePageRemote: vi.fn(async (id: string) => [id]),
    deleteDatabaseRowRemote: vi.fn(async (id: string) => [id]),
  };
});

vi.mock("@/lib/offlineFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offlineFiles")>()),
  clearOfflineWorkspaceFileCache,
}));

vi.mock("@/lib/recordCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recordCache")>()),
  cacheGetMeta,
  cacheListTable,
  cacheReplaceTable,
  cacheSetMeta,
  recordCacheClear,
  recordCacheIdle,
}));

import {
  bootstrapWorkspace,
  createDatabaseRemote,
  createPropertyRemote,
  createTemplateRemote,
  deleteDatabaseRowRemote,
  deletePageRemote,
  deletePropertyRemote,
  duplicatePageRemote,
  getDatabaseRowsRemote,
  getDatabaseSnapshotRemote,
  updateDatabaseRowRemote,
  updatePageRemote,
  updatePropertyRemote,
  updateTemplateRemote,
  updateViewRemote,
} from "@/lib/edgebase";
import { i18next } from "@/i18n";
import { flushAllPending, useStore } from "@/lib/store";
import {
  makePage,
  makeRow,
  resetStore,
  seedPages,
  seedUser,
  TEST_USER,
} from "./components/storeTestUtils";
import type { DbProperty, DbTemplate, DbView, ShareRole } from "@/lib/types";

beforeEach(async () => {
  await i18next.changeLanguage("en");
  vi.clearAllMocks();
  cacheGetMeta.mockResolvedValue(undefined);
  cacheListTable.mockResolvedValue([]);
  recordCacheClear.mockResolvedValue(true);
  resetStore();
  seedUser();
});

describe("store permission feedback", () => {
  it("sends the active browser locale for generated database resource names", async () => {
    await i18next.changeLanguage("ko");
    useStore.setState({ workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER } });

    await useStore.getState().createDatabase({
      parentId: null,
      parentType: "workspace",
      viewType: "calendar",
      seedRows: false,
      properties: [{ name: i18next.t("databaseView:name"), type: "title", position: 1 }],
    });

    expect(vi.mocked(createDatabaseRemote)).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "ko",
        viewType: "calendar",
        properties: [expect.objectContaining({ name: "이름", type: "title" })],
      })
    );
  });

  it.each([
    ["en", "en"],
    ["ko", "ko"],
  ] as const)("sends %s when duplicating a page", async (language, locale) => {
    await i18next.changeLanguage(language);
    const source = makePage({ id: `duplicate-${language}`, title: "Source" });
    seedPages([source]);

    await useStore.getState().duplicatePage(source.id);

    expect(vi.mocked(duplicatePageRemote)).toHaveBeenCalledWith(source.id, { locale });
  });

  it("preserves a user-authored Untitled template literal when localizing a copy suffix", async () => {
    await i18next.changeLanguage("ko");
    const database = makePage({ id: "template-copy-db", kind: "database" });
    seedPages([database]);
    const template = {
      id: "template-copy-source",
      databaseId: database.id,
      name: "Untitled template",
      title: "",
      properties: {},
      blocks: [],
      isDefault: false,
      position: 1,
    };
    useStore.setState({ templatesByDb: { [database.id]: [template] } });

    const copy = await useStore.getState().duplicateTemplate(template.id);

    expect(copy?.name).toBe("Untitled template 사본");
  });

  it.each(["create", "duplicate"] as const)(
    "returns null and rolls back a template %s after a terminal durable failure",
    async (operation) => {
      const database = makePage({ id: `template-drop-${operation}`, kind: "database" });
      seedPages([database]);
      const source = {
        id: "template-drop-source",
        databaseId: database.id,
        name: "Source",
        title: "Source",
        properties: {},
        blocks: [],
        isDefault: false,
        position: 1,
      };
      useStore.setState({
        templatesByDb: { [database.id]: operation === "duplicate" ? [source] : [] },
      });
      vi.mocked(createTemplateRemote).mockRejectedValueOnce(
        Object.assign(new Error("terminal create failure"), { status: 400 })
      );

      const result = operation === "create"
        ? await useStore.getState().addTemplate(database.id)
        : await useStore.getState().duplicateTemplate(source.id);

      expect(result).toBeNull();
      expect(useStore.getState().templatesByDb[database.id])
        .toEqual(operation === "duplicate" ? [source] : []);
    }
  );

  function propertyUndoFixture() {
    const database = makePage({ id: "property-undo-db", kind: "database" });
    const row = makeRow(database.id, {
      id: "property-undo-row",
      properties: { title: "Row" },
    });
    const property: DbProperty = {
      id: "property-undo-files",
      databaseId: database.id,
      name: "Files",
      type: "files",
      position: 2,
    };
    const title: DbProperty = {
      id: "title", databaseId: database.id, name: "Name", type: "title", position: 1,
    };
    const view: DbView = {
      id: "property-undo-view", databaseId: database.id, name: "Table", type: "table",
      position: 0, config: {},
    };
    const template: DbTemplate = {
      id: "property-undo-template", databaseId: database.id, name: "Template", position: 0,
      properties: {},
    };
    seedPages([database, row]);
    useStore.setState({
      propsByDb: { [database.id]: [title] },
      viewsByDb: { [database.id]: [view] },
      templatesByDb: { [database.id]: [template] },
      databaseRowIdsByDb: { [database.id]: [row.id] },
    });
    return {
      database,
      property,
      row,
      snapshot: {
        dbId: database.id,
        property,
        rows: [{ id: row.id, properties: { title: "Row", [property.id]: ["file-key"] } }],
        views: [{ id: view.id, config: { visibleProperties: ["title", property.id] } }],
        templates: [{ id: template.id, properties: { [property.id]: ["template-key"] } }],
        relatedProperties: [],
      },
    };
  }

  it("fails closed instead of restoring a property from a partial client snapshot", async () => {
    const { database, property, row, snapshot } = propertyUndoFixture();

    await expect(useStore.getState().restoreDeletedProperty(snapshot)).resolves.toBe(false);

    expect(createPropertyRemote).not.toHaveBeenCalled();
    expect(updatePageRemote).not.toHaveBeenCalled();
    expect(updateViewRemote).not.toHaveBeenCalled();
    expect(updateTemplateRemote).not.toHaveBeenCalled();
    expect(updatePropertyRemote).not.toHaveBeenCalled();
    expect(useStore.getState().dbProperties(database.id)).not.toContainEqual(property);
    expect(useStore.getState().pagesById[row.id].properties).toEqual({ title: "Row" });
  });

  it("rolls back an undo and sends no dependent restores when property recreation is rejected", async () => {
    const { database, property, row, snapshot } = propertyUndoFixture();

    await expect(useStore.getState().restoreDeletedProperty(snapshot)).resolves.toBe(false);

    expect(updatePageRemote).not.toHaveBeenCalled();
    expect(updateViewRemote).not.toHaveBeenCalled();
    expect(updateTemplateRemote).not.toHaveBeenCalled();
    expect(updatePropertyRemote).not.toHaveBeenCalled();
    expect(useStore.getState().dbProperties(database.id)).not.toContainEqual(property);
    expect(useStore.getState().pagesById[row.id].properties).toEqual({ title: "Row" });
    expect(useStore.getState().dbViews(database.id)[0].config?.visibleProperties ?? [])
      .not.toContain(property.id);
    expect(useStore.getState().dbTemplates(database.id)[0].properties).toEqual({});
  });

  it("returns null, skips redundant dependent writes, and reconciles a terminal property delete", async () => {
    const { database, property, row, snapshot } = propertyUndoFixture();
    const title = useStore.getState().dbProperties(database.id)[0];
    useStore.setState({
      propsByDb: { [database.id]: [title, property] },
      pagesById: {
        ...useStore.getState().pagesById,
        [row.id]: { ...row, properties: snapshot.rows[0].properties },
      },
      viewsByDb: {
        [database.id]: [{
          ...useStore.getState().dbViews(database.id)[0],
          config: snapshot.views[0].config,
        }],
      },
      templatesByDb: {
        [database.id]: [{
          ...useStore.getState().dbTemplates(database.id)[0],
          properties: snapshot.templates[0].properties,
        }],
      },
    });
    vi.mocked(deletePropertyRemote).mockRejectedValueOnce(
      Object.assign(new Error("delete rejected"), { status: 400 })
    );
    vi.mocked(getDatabaseSnapshotRemote).mockResolvedValueOnce({
      properties: [title, property],
      views: useStore.getState().dbViews(database.id),
      templates: useStore.getState().dbTemplates(database.id),
    });
    vi.mocked(getDatabaseRowsRemote).mockResolvedValueOnce({
      rows: [{ ...row, properties: snapshot.rows[0].properties }],
      hasMore: false,
      nextCursor: null,
    });

    await expect(useStore.getState().deleteProperty(property.id)).resolves.toBeNull();

    expect(updatePageRemote).not.toHaveBeenCalled();
    expect(updateViewRemote).not.toHaveBeenCalled();
    expect(updateTemplateRemote).not.toHaveBeenCalled();
    expect(updatePropertyRemote).not.toHaveBeenCalled();
    expect(useStore.getState().dbProperties(database.id)).toContainEqual(property);
    expect(useStore.getState().pagesById[row.id].properties).toEqual(snapshot.rows[0].properties);
  });

  it("removes every canonical view reference to a deleted property optimistically", async () => {
    const { database, property, row, snapshot } = propertyUndoFixture();
    const title = useStore.getState().dbProperties(database.id)[0];
    const survivorFilter = { propertyId: "title", operator: "contains" as const, value: "Row" };
    useStore.setState({
      propsByDb: { [database.id]: [title, property] },
      pagesById: {
        ...useStore.getState().pagesById,
        [row.id]: { ...row, properties: snapshot.rows[0].properties },
      },
      viewsByDb: {
        [database.id]: [{
          ...useStore.getState().dbViews(database.id)[0],
          config: {
            visibleProperties: ["title", property.id],
            hiddenProperties: [property.id],
            propertyOrder: ["title", property.id],
            rowPagePropertyOrder: [property.id, "title"],
            quickFilters: [
              { propertyId: property.id, operator: "equals", value: "x" },
              { conjunction: "and", filters: [{ propertyId: property.id, operator: "equals", value: "x" }] },
              survivorFilter,
            ],
            chartGroupBy: property.id,
            chartAggregateBy: property.id,
            templateLinkedRelationPropertyId: property.id,
          },
        }],
      },
    });

    await expect(useStore.getState().deleteProperty(property.id)).resolves.toBeTruthy();

    expect(useStore.getState().dbViews(database.id)[0].config).toEqual({
      visibleProperties: ["title"],
      hiddenProperties: [],
      propertyOrder: ["title"],
      rowPagePropertyOrder: ["title"],
      quickFilters: [survivorFilter],
    });
  });

  it("does not overwrite later row or template edits while rolling back a rejected property delete", async () => {
    const { database, property, row, snapshot } = propertyUndoFixture();
    const title = useStore.getState().dbProperties(database.id)[0];
    useStore.setState({
      propsByDb: { [database.id]: [title, property] },
      pagesById: {
        ...useStore.getState().pagesById,
        [row.id]: { ...row, properties: snapshot.rows[0].properties },
      },
      templatesByDb: {
        [database.id]: [{
          ...useStore.getState().dbTemplates(database.id)[0],
          properties: snapshot.templates[0].properties,
        }],
      },
    });
    let rejectDelete!: (reason?: unknown) => void;
    vi.mocked(deletePropertyRemote).mockImplementationOnce(
      () => new Promise<never>((_resolve, reject) => { rejectDelete = reject; })
    );
    vi.mocked(getDatabaseSnapshotRemote).mockRejectedValueOnce(new Error("snapshot unavailable"));

    const deleting = useStore.getState().deleteProperty(property.id);
    await vi.waitFor(() => expect(deletePropertyRemote).toHaveBeenCalledTimes(1));
    useStore.setState((state) => ({
      pagesById: {
        ...state.pagesById,
        [row.id]: {
          ...state.pagesById[row.id],
          properties: { ...state.pagesById[row.id].properties, title: "Edited later" },
        },
      },
      templatesByDb: {
        ...state.templatesByDb,
        [database.id]: state.templatesByDb[database.id].map((template) => ({
          ...template,
          properties: { ...template.properties, another: "Edited later" },
        })),
      },
    }));
    rejectDelete(Object.assign(new Error("delete rejected"), { status: 400 }));

    await expect(deleting).resolves.toBeNull();
    expect(useStore.getState().pagesById[row.id].properties).toEqual({
      title: "Edited later",
      [property.id]: ["file-key"],
    });
    expect(useStore.getState().dbTemplates(database.id)[0].properties).toEqual({
      another: "Edited later",
      [property.id]: ["template-key"],
    });
  });

  it("returns false and reconciles when a dependent property-undo restore is dropped", async () => {
    const { snapshot } = propertyUndoFixture();

    await expect(useStore.getState().restoreDeletedProperty(snapshot)).resolves.toBe(false);

    expect(getDatabaseSnapshotRemote).not.toHaveBeenCalled();
  });

  it("refreshes stale page roles before a newly granted row edit is saved", async () => {
    const root = makePage({
      id: "root",
      title: "Shared root",
      createdBy: "owner-user",
    });
    const database = makePage({
      id: "db",
      kind: "database",
      title: "Shared database",
      parentId: root.id,
      parentType: "page",
      createdBy: "owner-user",
    });
    const row = makeRow(database.id, {
      id: "row",
      title: "Row",
      createdBy: "owner-user",
      properties: {},
    });
    seedPages([root, database, row]);
    useStore.setState({
      workspace: { id: "ws-1", name: "Workspace", ownerId: "owner-user" },
      pageRolesById: { [root.id]: "view", [database.id]: "view", [row.id]: "view" },
    });
    vi.mocked(bootstrapWorkspace).mockResolvedValueOnce({
      userId: TEST_USER,
      workspace: { id: "ws-1", name: "Workspace", ownerId: "owner-user" },
      currentMember: undefined,
      members: [],
      pages: [root, database, row],
      pageRoles: { [root.id]: "edit", [database.id]: "edit", [row.id]: "edit" },
      sharedPageIds: [root.id],
    });

    await useStore.getState().refreshPageAccess(row.id);
    useStore.getState().setRowProperty(row.id, "prop", "value", { debounce: false });
    await flushAllPending();

    expect(bootstrapWorkspace).toHaveBeenCalledWith({ pageId: row.id });
    expect(useStore.getState().pageRolesById[row.id]).toBe("edit");
    expect(vi.mocked(updateDatabaseRowRemote)).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({ properties: { prop: "value" } })
    );
    expect(
      useStore.getState().toasts.some((toast) => toast.message.includes("edit access"))
    ).toBe(false);
  });

  it("uses inherited page roles to save nested database row edits for direct-share users", async () => {
    const root = makePage({
      id: "root",
      title: "Shared root",
      createdBy: "owner-user",
    });
    const database = makePage({
      id: "db",
      kind: "database",
      title: "Shared database",
      parentId: root.id,
      parentType: "page",
      createdBy: "owner-user",
    });
    const row = makeRow(database.id, {
      id: "row",
      title: "Row",
      createdBy: "owner-user",
      properties: {},
    });
    seedPages([root, database, row]);
    useStore.setState({ pageRolesById: { [root.id]: "edit" } });

    useStore.getState().setRowProperty(row.id, "prop", "value", { debounce: false });
    await flushAllPending();

    const state = useStore.getState();
    expect(state.pagesById[row.id].properties?.prop).toBe("value");
    expect(vi.mocked(updateDatabaseRowRemote)).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({ properties: { prop: "value" } })
    );
    expect(state.toasts.some((toast) => toast.message.includes("edit access"))).toBe(false);
  });

  it.each([
    ["view", false],
    ["comment", false],
    ["edit", true],
    ["full_access", true],
  ] as Array<[ShareRole, boolean]>)(
    "applies the %s role consistently to database row property saves",
    async (role, canSave) => {
      const database = makePage({
        id: `db-${role}`,
        kind: "database",
        title: `${role} database`,
        createdBy: "owner-user",
      });
      const row = makeRow(database.id, {
        id: `row-${role}`,
        title: `${role} row`,
        createdBy: "owner-user",
        properties: {},
      });
      seedPages([database, row]);
      useStore.setState({ pageRolesById: { [database.id]: role, [row.id]: role } });

      useStore.getState().setRowProperty(row.id, "prop", role, { debounce: false });
      await flushAllPending();

      if (canSave) {
        expect(useStore.getState().pagesById[row.id].properties?.prop).toBe(role);
        expect(vi.mocked(updateDatabaseRowRemote)).toHaveBeenCalledWith(
          row.id,
          expect.objectContaining({ properties: { prop: role } })
        );
        expect(
          useStore.getState().toasts.some((toast) => toast.message.includes("edit access"))
        ).toBe(false);
      } else {
        expect(useStore.getState().pagesById[row.id].properties?.prop).toBeUndefined();
        expect(vi.mocked(updateDatabaseRowRemote)).not.toHaveBeenCalled();
        expect(
          useStore.getState().toasts.some((toast) => toast.message.includes("edit access"))
        ).toBe(true);
      }
    }
  );

  it("shows a toast instead of silently dropping page edits without edit access", () => {
    seedPages([
      makePage({ id: "shared-readonly", title: "Read only", createdBy: "owner-user" }),
    ]);

    useStore.getState().updatePage("shared-readonly", { title: "Changed" });

    const state = useStore.getState();
    expect(state.pagesById["shared-readonly"].title).toBe("Read only");
    expect(state.toasts.some((toast) => toast.message.includes("edit access"))).toBe(true);
  });

  it("shows a toast when a locked database blocks a row property edit", () => {
    const database = makePage({
      id: "db",
      kind: "database",
      title: "Locked database",
      createdBy: TEST_USER,
      isLocked: true,
    });
    const row = makeRow(database.id, {
      id: "row",
      title: "Row",
      createdBy: TEST_USER,
      properties: {},
    });
    seedPages([database, row]);

    useStore.getState().setRowProperty(row.id, "prop", "value", { debounce: false });

    const state = useStore.getState();
    expect(state.pagesById[row.id].properties?.prop).toBeUndefined();
    expect(state.toasts.some((toast) => toast.message.includes("database is locked"))).toBe(true);
  });

  it("shows a toast when the server rejects a saved page edit for permissions", async () => {
    seedPages([makePage({ id: "mine", title: "Mine", createdBy: TEST_USER })]);
    vi.mocked(updatePageRemote).mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );

    useStore.getState().updatePage("mine", { title: "Changed" }, { debounce: false });
    await flushAllPending();

    expect(
      useStore.getState().toasts.some((toast) => toast.message.includes("edit access"))
    ).toBe(true);
  });
});

describe("permanent page deletion", () => {
  it("requires Trash state and manage-level authority before calling the server", async () => {
    const active = makePage({ id: "active", title: "Active", createdBy: "owner-user" });
    const trashed = makePage({
      id: "trashed-edit-only",
      title: "Trashed",
      createdBy: "owner-user",
      inTrash: true,
    });
    seedPages([active, trashed]);
    useStore.setState({
      workspace: { id: "ws-1", name: "Workspace", ownerId: "owner-user" },
      currentMember: {
        id: "member-editor",
        workspaceId: "ws-1",
        userId: TEST_USER,
        role: "member",
      },
      pageRolesById: { active: "edit", "trashed-edit-only": "edit" },
    });

    expect(useStore.getState().canPermanentlyDeletePage(active.id)).toBe(false);
    expect(useStore.getState().canPermanentlyDeletePage(trashed.id)).toBe(false);
    await expect(useStore.getState().deletePage(active.id)).rejects.toThrow(/trash/i);
    await expect(useStore.getState().deletePage(trashed.id)).rejects.toThrow(/full page access/i);

    expect(vi.mocked(deletePageRemote)).not.toHaveBeenCalled();
    expect(useStore.getState().pagesById[active.id]).toBeDefined();
    expect(useStore.getState().pagesById[trashed.id]).toBeDefined();
  });

  it("keeps the full local subtree when the online delete is not confirmed", async () => {
    const root = makePage({ id: "delete-fails", inTrash: true });
    const child = makePage({
      id: "delete-fails-child",
      parentId: root.id,
      parentType: "page",
      inTrash: true,
    });
    seedPages([root, child]);
    useStore.setState({ workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER } });
    vi.mocked(deletePageRemote).mockRejectedValueOnce(
      Object.assign(new Error("offline"), { status: 503 })
    );

    await expect(useStore.getState().deletePage(root.id)).rejects.toThrow("offline");

    expect(useStore.getState().pagesById[root.id]).toBeDefined();
    expect(useStore.getState().pagesById[child.id]).toBeDefined();
  });

  it("removes only server-confirmed ids from every mounted page cache and index", async () => {
    const root = makePage({ id: "delete-root", inTrash: true });
    const database = makePage({
      id: "delete-db",
      kind: "database",
      parentId: root.id,
      parentType: "page",
      inTrash: true,
    });
    const row = makeRow(database.id, { id: "delete-row", inTrash: true });
    const survivor = makePage({ id: "survivor", title: "Keep me" });
    seedPages([root, database, row, survivor]);
    useStore.setState({
      workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
      pageRolesById: {
        [root.id]: "full_access",
        [database.id]: "full_access",
        [row.id]: "full_access",
        [survivor.id]: "full_access",
      },
      sharedPageIds: new Set([root.id, survivor.id]),
      recentPageIds: [root.id, survivor.id],
      treeExpandedPageIds: new Set([root.id, survivor.id]),
      blocksByPage: { [root.id]: [], [survivor.id]: [] },
      loadedBlockPages: new Set([root.id, survivor.id]),
      blockHistoryByPage: { [root.id]: { past: [], future: [] } },
      commentsByPage: { [root.id]: [], [survivor.id]: [] },
      loadedCommentPages: new Set([root.id, survivor.id]),
      propsByDb: { [database.id]: [] },
      viewsByDb: { [database.id]: [] },
      templatesByDb: { [database.id]: [] },
      loadedDbs: new Set([database.id]),
      databaseRowIdsByDb: { [database.id]: [row.id] },
      databaseRowPagesByDb: {
        [database.id]: { loadedCount: 1, totalCount: 1, hasMore: false },
      },
      hydratedRelationTargetIds: new Set([row.id, survivor.id]),
      commentPanel: { pageId: root.id },
      focusPageId: root.id,
      focusPageTarget: "title",
    });
    vi.mocked(deletePageRemote).mockResolvedValueOnce([root.id, database.id, row.id]);

    await useStore.getState().deletePage(root.id);

    const state = useStore.getState();
    expect(vi.mocked(deletePageRemote)).toHaveBeenCalledWith(root.id, root.workspaceId);
    expect(Object.keys(state.pagesById)).toEqual([survivor.id]);
    expect(state.pageRolesById).toEqual({ [survivor.id]: "full_access" });
    expect(Array.from(state.sharedPageIds)).toEqual([survivor.id]);
    expect(state.recentPageIds).toEqual([survivor.id]);
    expect(Array.from(state.treeExpandedPageIds)).toEqual([survivor.id]);
    expect(Array.from(state.loadedBlockPages)).toEqual([survivor.id]);
    expect(Array.from(state.loadedCommentPages)).toEqual([survivor.id]);
    expect(state.propsByDb[database.id]).toBeUndefined();
    expect(state.databaseRowIdsByDb[database.id]).toBeUndefined();
    expect(state.commentPanel).toBeUndefined();
    expect(state.focusPageId).toBeUndefined();
    expect(Array.from(state.hydratedRelationTargetIds)).toEqual([survivor.id]);
    expect(clearOfflineWorkspaceFileCache).toHaveBeenCalledTimes(1);
    expect(recordCacheClear).toHaveBeenCalledWith(TEST_USER);
    expect(
      JSON.parse(
        window.localStorage.getItem(`hanji.permanentDeletes:${TEST_USER}`) ?? "[]"
      )
    ).toEqual(expect.arrayContaining([root.id, database.id, row.id]));
  });

  it("applies another tab's permanent tombstone before stale local data can render", () => {
    const root = makePage({ id: "cross-tab-delete", inTrash: true });
    const child = makePage({
      id: "cross-tab-child",
      parentId: root.id,
      parentType: "page",
      inTrash: true,
    });
    seedPages([root, child]);
    useStore.setState({
      blocksByPage: { [root.id]: [] },
      loadedBlockPages: new Set([root.id]),
      pageRolesById: { [root.id]: "full_access", [child.id]: "full_access" },
    });
    const key = `hanji.permanentDeletes:${TEST_USER}`;
    const value = JSON.stringify([root.id, child.id]);
    window.localStorage.setItem(key, value);

    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));

    expect(useStore.getState().pagesById[root.id]).toBeUndefined();
    expect(useStore.getState().pagesById[child.id]).toBeUndefined();
    expect(useStore.getState().blocksByPage[root.id]).toBeUndefined();
    expect(recordCacheClear).toHaveBeenCalledWith(TEST_USER);
    expect(clearOfflineWorkspaceFileCache).toHaveBeenCalled();
  });

  it("uses the database-row endpoint only after the same manage checks", async () => {
    const database = makePage({ id: "row-db", kind: "database" });
    const row = makeRow(database.id, { id: "row-delete", inTrash: true });
    const keptRow = makeRow(database.id, { id: "row-kept" });
    seedPages([database, row, keptRow]);
    useStore.setState({ workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER } });
    cacheGetMeta.mockImplementation(async (_userId: string, key: string) => {
      if (key === `rowsKeys:${database.id}`) return [{ h: "base" }];
      if (key === `rows:${database.id}:base`) {
        return {
          hasMore: false,
          queryKey: "{}",
          rowIds: [row.id, keptRow.id],
          totalCount: 2,
        };
      }
      return undefined;
    });
    cacheListTable.mockImplementation(async (_userId: string, table: string) => {
      if (table === `rowsdata:${database.id}:base`) {
        return [
          { id: row.id, value: row },
          { id: keptRow.id, value: keptRow },
        ];
      }
      return [];
    });

    await useStore.getState().deletePage(row.id);

    expect(vi.mocked(deleteDatabaseRowRemote)).toHaveBeenCalledWith(row.id, row.workspaceId);
    expect(useStore.getState().pagesById[row.id]).toBeUndefined();
    expect(useStore.getState().pagesById[database.id]).toBeDefined();
    expect(recordCacheClear).toHaveBeenCalledWith(TEST_USER);
  });

  it("does not optimistically duplicate a template that contains a stored file", async () => {
    const database = makePage({ id: "template-db", kind: "database" });
    seedPages([database]);
    const template = {
      id: "template-with-file",
      databaseId: database.id,
      name: "File template",
      title: "",
      properties: {},
      blocks: [{
        type: "file" as const,
        content: {
          uploadId: "upload-1",
          url: "/api/storage/files/workspaces/ws-1/templates/file.bin",
        },
      }],
      isDefault: false,
      position: 1,
    };
    useStore.setState({ templatesByDb: { [database.id]: [template] } });

    const result = await useStore.getState().duplicateTemplate(template.id);

    expect(result).toBeNull();
    expect(useStore.getState().templatesByDb[database.id]).toEqual([template]);
  });
});
