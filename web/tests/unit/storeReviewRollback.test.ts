// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in store rollback test.");
    }),
    createDatabaseRowRemote: vi.fn(async () => {
      throw new Error("Unexpected createDatabaseRowRemote in store rollback test.");
    }),
    moveDatabaseRowRemote: vi.fn(async () => {
      throw new Error("Unexpected moveDatabaseRowRemote in store rollback test.");
    }),
  };
});

import { createDatabaseRowRemote, moveDatabaseRowRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import {
  localBoxIfSettled,
  resetLocalLockForTests,
} from "@/lib/localLock";
import { makePage, makeRow, resetStore, seedPages, seedUser, TEST_USER } from "./components/storeTestUtils";

// Mirrors localLock.MODE_KEY (not exported from the module).
const MODE_KEY = "hanji.encryption.mode";

function droppedError(status: number) {
  // shouldDropPersistError() treats these statuses as terminal (non-transient),
  // so durableRemoteCall resolves { status: "dropped" } instead of retrying.
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  resetLocalLockForTests();
  seedUser();
  useStore.setState({
    workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
  });
});

describe("moveDatabaseRow order rollback (#18)", () => {
  it("restores the pre-move databaseRowIdsByDb order after a terminal rejection", async () => {
    const database = makePage({
      id: "db",
      kind: "database",
      title: "Database",
      createdBy: TEST_USER,
    });
    const r1 = makeRow(database.id, { id: "r1", title: "Row 1", position: 1 });
    const r2 = makeRow(database.id, { id: "r2", title: "Row 2", position: 2 });
    const r3 = makeRow(database.id, { id: "r3", title: "Row 3", position: 3 });
    seedPages([database, r1, r2, r3]);
    useStore.setState((s) => ({
      pageRolesById: { ...s.pageRolesById, [database.id]: "edit" },
      databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [database.id]: ["r1", "r2", "r3"] },
    }));

    vi.mocked(moveDatabaseRowRemote).mockRejectedValueOnce(droppedError(400));

    // Move r1 to the end; the optimistic order becomes ["r2","r3","r1"].
    const result = await useStore.getState().moveDatabaseRow("r1", "r3", "after");

    expect(result).toBeUndefined();
    // The dropped branch must restore both the position and the visible order.
    expect(useStore.getState().databaseRowIdsByDb["db"]).toEqual(["r1", "r2", "r3"]);
    expect(useStore.getState().dbRows("db").map((row) => row.id)).toEqual(["r1", "r2", "r3"]);
  });
});

describe("addRow phantom rollback (#19)", () => {
  it("returns the optimistic row immediately and removes it after a terminal rejection", async () => {
    const database = makePage({
      id: "db",
      kind: "database",
      title: "Database",
      createdBy: TEST_USER,
    });
    seedPages([database]);
    useStore.setState((s) => ({
      pageRolesById: { ...s.pageRolesById, [database.id]: "edit" },
      databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [database.id]: [] },
    }));

    vi.mocked(createDatabaseRowRemote).mockRejectedValueOnce(droppedError(403));

    const idsBefore = Object.keys(useStore.getState().pagesById).sort();

    const row = await useStore.getState().addRow("db");
    expect(useStore.getState().pagesById[row.id]).toEqual(row);

    await vi.waitFor(() => {
      const state = useStore.getState();
      // No phantom page survives in either the id map or the ordered row list.
      expect(Object.keys(state.pagesById).sort()).toEqual(idsBefore);
      expect(state.databaseRowIdsByDb["db"]).toEqual([]);
    });
  });

  it("guards addRow with the create-page permission check", async () => {
    const database = makePage({
      id: "db-noaccess",
      kind: "database",
      title: "No access database",
      createdBy: "owner-user",
    });
    seedPages([database]);
    // Non-owner workspace + view-only role: canCreatePageInState must reject
    // before any remote call. (The default beforeEach workspace is owned by
    // TEST_USER, which would otherwise grant full access.)
    useStore.setState((s) => ({
      workspace: { id: "ws-1", name: "Workspace", ownerId: "owner-user" },
      currentMember: undefined,
      pageRolesById: { ...s.pageRolesById, [database.id]: "view" },
    }));

    await expect(useStore.getState().addRow("db-noaccess")).rejects.toThrow(/access/i);
    expect(vi.mocked(createDatabaseRowRemote)).not.toHaveBeenCalled();
  });

  it("does not create an optimistic row from a template that would share a stored file", async () => {
    const database = makePage({
      id: "db-file-template",
      kind: "database",
      title: "File template database",
      createdBy: TEST_USER,
    });
    seedPages([database]);
    useStore.setState((state) => ({
      pageRolesById: { ...state.pageRolesById, [database.id]: "edit" },
      databaseRowIdsByDb: { ...state.databaseRowIdsByDb, [database.id]: [] },
      propsByDb: {
        ...state.propsByDb,
        [database.id]: [{
          id: "files",
          databaseId: database.id,
          name: "Files",
          type: "files",
          config: {},
          position: 0,
        }],
      },
      templatesByDb: {
        ...state.templatesByDb,
        [database.id]: [{
          id: "template-file",
          databaseId: database.id,
          name: "File template",
          title: "",
          properties: { files: ["workspaces/ws-1/files/template.pdf"] },
          blocks: [],
          isDefault: true,
          position: 0,
        }],
      },
    }));

    await expect(useStore.getState().addRow(database.id)).rejects.toThrow(/stored files/i);
    expect(useStore.getState().databaseRowIdsByDb[database.id]).toEqual([]);
    expect(vi.mocked(createDatabaseRowRemote)).not.toHaveBeenCalled();
  });
});

describe("localLock cross-tab re-key invalidation (#25)", () => {
  it("invalidates the cached gate when MODE_KEY changes in another tab", () => {
    window.localStorage.removeItem(MODE_KEY);
    const userId = "user-1";

    // First read caches a device-mode gate (and installs the storage listener).
    expect(localBoxIfSettled(userId)).toBe("device");

    // Another tab enables the passphrase lock: the value changes and a storage
    // event is delivered to this tab.
    window.localStorage.setItem(MODE_KEY, "passphrase");
    window.dispatchEvent(
      new StorageEvent("storage", { key: MODE_KEY, newValue: "passphrase" })
    );

    // The stale device gate is dropped; the next read reflects passphrase mode
    // (a pending gate that blocks seals until this tab unlocks) rather than
    // continuing to seal under the device key.
    expect(localBoxIfSettled(userId)).toBe("pending");
  });
});
