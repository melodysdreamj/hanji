// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in store permission test.");
    }),
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
  };
});

import { bootstrapWorkspace, updateDatabaseRowRemote, updatePageRemote } from "@/lib/edgebase";
import { flushAllPending, useStore } from "@/lib/store";
import {
  makePage,
  makeRow,
  resetStore,
  seedPages,
  seedUser,
  TEST_USER,
} from "./components/storeTestUtils";
import type { ShareRole } from "@/lib/types";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  seedUser();
});

describe("store permission feedback", () => {
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
