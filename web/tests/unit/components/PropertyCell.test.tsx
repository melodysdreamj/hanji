// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  bootstrapWorkspace,
  deleteWorkspaceFile,
  evictCachedWorkspaceFiles,
  getPageRemote,
  updateDatabaseRowRemote,
} = vi.hoisted(() => ({
  bootstrapWorkspace: vi.fn(async () => {
    throw Object.assign(new Error("access unavailable"), { status: 403 });
  }),
  deleteWorkspaceFile: vi.fn(async () => undefined),
  evictCachedWorkspaceFiles: vi.fn(async () => undefined),
  getPageRemote: vi.fn(async () => undefined),
  updateDatabaseRowRemote: vi.fn(async () => undefined),
}));

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace,
    getPageRemote,
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote,
    updatePropertyRemote: vi.fn(async () => undefined),
    searchOrganizationPeopleRemote: vi.fn(async () => ({ people: [] })),
  };
});

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  createWorkspaceFileDownloadUrl: vi.fn(async () => ({
    url: "https://files.example/signed",
    expiresAt: "2099-01-01T00:00:00.000Z",
  })),
  deleteWorkspaceFile,
}));

vi.mock("@/lib/offlineFiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offlineFiles")>()),
  evictCachedWorkspaceFiles,
}));

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

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteWorkspaceFile.mockResolvedValue(undefined);
  evictCachedWorkspaceFiles.mockResolvedValue(undefined);
  getPageRemote.mockResolvedValue(undefined);
  updateDatabaseRowRemote.mockResolvedValue(undefined);
  resetStore();
  seedUser();
  seedPages([makePage({ id: DB_ID, kind: "database", title: "Tasks" })]);
});
afterEach(cleanup);

describe("PropertyCell", () => {
  it("opens image attachments in an accessible in-app preview and restores focus", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, {
      id: "row-image-preview",
      properties: {
        files: [{
          id: "preview-image",
          name: "preview.png",
          type: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo=",
        }],
      },
    });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    const open = screen.getByRole("link", { name: "Open preview.png" });
    open.focus();
    fireEvent.click(open);

    const dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("img", { name: "preview.png" }).getAttribute("src")).toContain("data:image/png");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
    expect(document.body.style.overflow).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("detaches a stored file through the row update without raw deletion and preserves concurrent files", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const attachment = {
      id: "workspaces/ws/files/remove.pdf",
      key: "workspaces/ws/files/remove.pdf",
      name: "remove.pdf",
      url: "/api/storage/files/workspaces/ws/files/remove.pdf",
    };
    const concurrentlyAdded = {
      id: "https://files.example/concurrent.pdf",
      name: "concurrent.pdf",
      url: "https://files.example/concurrent.pdf",
    };
    const row = makeRow(DB_ID, {
      id: "row-file-success",
      properties: { files: [attachment] },
    });
    seedPages([row]);
    let resolveRemote!: (value: unknown) => void;
    updateDatabaseRowRemote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemote = resolve;
        })
    );

    render(<PropertyCell row={row} prop={prop} />);
    // Simulate a second control adding a file after this cell rendered. The
    // removal must re-read store truth rather than overwrite that addition
    // with the stale one-file render closure.
    useStore.setState((state) => ({
      pagesById: {
        ...state.pagesById,
        [row.id]: {
          ...state.pagesById[row.id],
          properties: { files: [attachment, concurrentlyAdded] },
        },
      },
    }));
    const remove = screen.getByRole("button", { name: "Remove remove.pdf" });
    fireEvent.click(remove);
    fireEvent.click(remove);

    await waitFor(() => expect(rowValue(row.id, prop.id)).toEqual([concurrentlyAdded]));
    await waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(1));
    expect(updateDatabaseRowRemote).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({ properties: { files: [concurrentlyAdded] } })
    );
    expect(deleteWorkspaceFile).not.toHaveBeenCalled();
    // The server has not committed yet, so offline bytes must remain usable.
    expect(evictCachedWorkspaceFiles).not.toHaveBeenCalled();

    resolveRemote({ ...row, properties: { files: [concurrentlyAdded] } });
    await waitFor(() => expect(evictCachedWorkspaceFiles).toHaveBeenCalledTimes(1));
    expect(evictCachedWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(evictCachedWorkspaceFiles).toHaveBeenCalledWith([attachment.key]);
  });

  it("serializes rapid removals on one row property so an older response cannot resurrect a file", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const first = {
      id: "workspaces/ws/files/first.pdf",
      key: "workspaces/ws/files/first.pdf",
      name: "first.pdf",
      url: "/api/storage/files/workspaces/ws/files/first.pdf",
    };
    const second = {
      id: "workspaces/ws/files/second.pdf",
      key: "workspaces/ws/files/second.pdf",
      name: "second.pdf",
      url: "/api/storage/files/workspaces/ws/files/second.pdf",
    };
    const row = makeRow(DB_ID, {
      id: "row-file-serialized",
      properties: { files: [first, second] },
    });
    seedPages([row]);

    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    updateDatabaseRowRemote
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );

    render(<PropertyCell row={row} prop={prop} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove first.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove second.pdf" }));

    await waitFor(() => expect(rowValue(row.id, prop.id)).toBeNull());
    await waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(1));
    expect(updateDatabaseRowRemote).toHaveBeenNthCalledWith(
      1,
      row.id,
      expect.objectContaining({ properties: { files: [second] } })
    );
    // The second request is intentionally not started while the first could
    // still complete later and overwrite its null snapshot.
    expect(resolveSecond).toBeUndefined();

    resolveFirst({ ...row, properties: { files: [second] } });
    await waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(2));
    expect(updateDatabaseRowRemote).toHaveBeenNthCalledWith(
      2,
      row.id,
      expect.objectContaining({ properties: { files: null } })
    );
    resolveSecond({ ...row, properties: { files: null } });

    await waitFor(() => expect(evictCachedWorkspaceFiles).toHaveBeenCalledTimes(2));
    expect(rowValue(row.id, prop.id)).toBeNull();
    expect(evictCachedWorkspaceFiles).toHaveBeenCalledWith([first.key]);
    expect(evictCachedWorkspaceFiles).toHaveBeenCalledWith([second.key]);
  });

  it("waits for an earlier file-property save before detaching from its committed snapshot", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const attachment = {
      id: "workspaces/ws/files/existing.pdf",
      key: "workspaces/ws/files/existing.pdf",
      name: "existing.pdf",
      url: "/api/storage/files/workspaces/ws/files/existing.pdf",
    };
    const added = {
      id: "https://files.example/added-first.pdf",
      name: "added-first.pdf",
      url: "https://files.example/added-first.pdf",
    };
    const row = makeRow(DB_ID, {
      id: "row-file-earlier-save",
      properties: { files: [attachment] },
    });
    seedPages([row]);
    let resolveEarlier!: (value: unknown) => void;
    let resolveRemoval!: (value: unknown) => void;
    updateDatabaseRowRemote
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveEarlier = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRemoval = resolve;
          })
      );

    render(<PropertyCell row={row} prop={prop} />);
    useStore
      .getState()
      .setRowProperty(row.id, prop.id, [attachment, added], { debounce: false });
    fireEvent.click(screen.getByRole("button", { name: "Remove existing.pdf" }));

    await waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(1));
    expect(updateDatabaseRowRemote).toHaveBeenNthCalledWith(
      1,
      row.id,
      expect.objectContaining({ properties: { files: [attachment, added] } })
    );
    expect(resolveRemoval).toBeUndefined();

    resolveEarlier({ ...row, properties: { files: [attachment, added] } });
    await waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(2));
    expect(updateDatabaseRowRemote).toHaveBeenNthCalledWith(
      2,
      row.id,
      expect.objectContaining({ properties: { files: [added] } })
    );
    resolveRemoval({ ...row, properties: { files: [added] } });

    await waitFor(() => expect(evictCachedWorkspaceFiles).toHaveBeenCalledWith([attachment.key]));
    expect(rowValue(row.id, prop.id)).toEqual([added]);
  });

  it("restores only the first failed removal while a later queued removal still commits", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const first = {
      id: "workspaces/ws/files/denied.pdf",
      key: "workspaces/ws/files/denied.pdf",
      name: "denied.pdf",
      url: "/api/storage/files/workspaces/ws/files/denied.pdf",
    };
    const second = {
      id: "workspaces/ws/files/allowed.pdf",
      key: "workspaces/ws/files/allowed.pdf",
      name: "allowed.pdf",
      url: "/api/storage/files/workspaces/ws/files/allowed.pdf",
    };
    const row = makeRow(DB_ID, {
      id: "row-file-partial-drop",
      properties: { files: [first, second] },
    });
    seedPages([row]);
    updateDatabaseRowRemote
      .mockRejectedValueOnce(httpError(409))
      .mockResolvedValueOnce({ ...row, properties: { files: [first] } });
    getPageRemote.mockResolvedValueOnce(row);

    render(<PropertyCell row={row} prop={prop} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove denied.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove allowed.pdf" }));

    await waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowValue(row.id, prop.id)).toEqual([first]));
    expect(updateDatabaseRowRemote).toHaveBeenNthCalledWith(
      2,
      row.id,
      expect.objectContaining({ properties: { files: [first] } })
    );
    expect(evictCachedWorkspaceFiles).not.toHaveBeenCalledWith([first.key]);
    expect(evictCachedWorkspaceFiles).toHaveBeenCalledWith([second.key]);
  });

  it("reloads the authoritative row on a terminal conflict and does not evict cache", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const attachment = {
      id: "workspaces/ws/files/conflict.pdf",
      key: "workspaces/ws/files/conflict.pdf",
      name: "conflict.pdf",
      url: "/api/storage/files/workspaces/ws/files/conflict.pdf",
    };
    const collaboratorFile = {
      id: "https://files.example/collaborator.pdf",
      name: "collaborator.pdf",
      url: "https://files.example/collaborator.pdf",
    };
    const row = makeRow(DB_ID, {
      id: "row-file-conflict",
      properties: { files: [attachment] },
    });
    seedPages([row]);
    updateDatabaseRowRemote.mockRejectedValueOnce(httpError(409));
    getPageRemote.mockResolvedValueOnce({
      ...row,
      properties: { files: [attachment, collaboratorFile] },
    });

    render(<PropertyCell row={row} prop={prop} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove conflict.pdf" }));

    await waitFor(() =>
      expect(rowValue(row.id, prop.id)).toEqual([attachment, collaboratorFile])
    );
    expect(getPageRemote).toHaveBeenCalledWith(row.id);
    expect(evictCachedWorkspaceFiles).not.toHaveBeenCalled();
    expect(deleteWorkspaceFile).not.toHaveBeenCalled();
  });

  it("conditionally rolls back only the failed file while preserving a concurrent addition", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const attachment = {
      id: "workspaces/ws/files/rollback.pdf",
      key: "workspaces/ws/files/rollback.pdf",
      name: "rollback.pdf",
      url: "/api/storage/files/workspaces/ws/files/rollback.pdf",
    };
    const concurrent = {
      id: "https://files.example/after-click.pdf",
      name: "after-click.pdf",
      url: "https://files.example/after-click.pdf",
    };
    const row = makeRow(DB_ID, {
      id: "row-file-rollback",
      properties: { files: [attachment] },
    });
    seedPages([row]);
    let rejectRemote!: (reason: unknown) => void;
    updateDatabaseRowRemote.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRemote = reject;
        })
    );
    getPageRemote.mockRejectedValueOnce(new TypeError("authoritative read offline"));

    render(<PropertyCell row={row} prop={prop} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove rollback.pdf" }));
    await waitFor(() => expect(rowValue(row.id, prop.id)).toBeNull());
    useStore.setState((state) => ({
      pagesById: {
        ...state.pagesById,
        [row.id]: {
          ...state.pagesById[row.id],
          properties: { files: [concurrent] },
        },
      },
    }));
    rejectRemote(httpError(409));

    await waitFor(() => expect(rowValue(row.id, prop.id)).toEqual([attachment, concurrent]));
    expect(evictCachedWorkspaceFiles).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])(
    "removes an unreadable stale row after terminal HTTP %s instead of restoring its file URL",
    async (status) => {
      const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
      seedDbProps(DB_ID, [prop]);
      const attachment = {
        id: `workspaces/ws/files/private-${status}.pdf`,
        key: `workspaces/ws/files/private-${status}.pdf`,
        name: `private-${status}.pdf`,
        url: `/api/storage/files/workspaces/ws/files/private-${status}.pdf`,
      };
      const row = makeRow(DB_ID, {
        id: `row-file-private-${status}`,
        properties: { files: [attachment] },
      });
      seedPages([row]);
      useStore.setState((state) => ({
        databaseRowIdsByDb: {
          ...state.databaseRowIdsByDb,
          [DB_ID]: [row.id],
        },
      }));
      updateDatabaseRowRemote.mockRejectedValueOnce(httpError(status));
      getPageRemote.mockRejectedValueOnce(httpError(status));

      render(<PropertyCell row={row} prop={prop} />);
      fireEvent.click(
        screen.getByRole("button", { name: `Remove private-${status}.pdf` })
      );

      await waitFor(() => expect(useStore.getState().pagesById[row.id]).toBeUndefined());
      expect(useStore.getState().databaseRowIdsByDb[DB_ID]).not.toContain(row.id);
      expect(evictCachedWorkspaceFiles).not.toHaveBeenCalled();
      expect(deleteWorkspaceFile).not.toHaveBeenCalled();
    }
  );

  it("keeps a stored-file detach committed when best-effort cache eviction fails", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const attachment = {
      id: "workspaces/ws/files/cached.pdf",
      key: "workspaces/ws/files/cached.pdf",
      name: "cached.pdf",
      url: "/api/storage/files/workspaces/ws/files/cached.pdf",
    };
    const row = makeRow(DB_ID, {
      id: "row-file-cache-failure",
      properties: { files: [attachment] },
    });
    seedPages([row]);
    evictCachedWorkspaceFiles.mockRejectedValueOnce(new Error("cache unavailable"));

    render(<PropertyCell row={row} prop={prop} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove cached.pdf" }));

    await waitFor(() => expect(rowValue(row.id, prop.id)).toBeNull());
    await waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(1));
    expect(deleteWorkspaceFile).not.toHaveBeenCalled();
    expect(evictCachedWorkspaceFiles).toHaveBeenCalledWith([attachment.key]);
  });

  it("keeps shared cached bytes while the committed row still references the same storage key", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const sharedKey = "workspaces/ws/files/shared.pdf";
    const first = {
      id: "attachment-first",
      key: sharedKey,
      name: "first-label.pdf",
      url: `/api/storage/files/${sharedKey}`,
    };
    const second = {
      id: "attachment-second",
      key: sharedKey,
      name: "second-label.pdf",
      url: `/api/storage/files/${sharedKey}`,
    };
    const row = makeRow(DB_ID, {
      id: "row-file-shared-cache",
      properties: { files: [first, second] },
    });
    seedPages([row]);
    updateDatabaseRowRemote.mockResolvedValueOnce({
      ...row,
      properties: { files: [second] },
    });

    render(<PropertyCell row={row} prop={prop} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove first-label.pdf" }));

    await waitFor(() => expect(rowValue(row.id, prop.id)).toEqual([second]));
    await waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(1));
    expect(evictCachedWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("removes an external file link without storage deletion or cache eviction", async () => {
    const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
    seedDbProps(DB_ID, [prop]);
    const attachment = {
      id: "https://files.example/manual.pdf",
      name: "manual.pdf",
      url: "https://files.example/manual.pdf",
    };
    const row = makeRow(DB_ID, {
      id: "row-external-file",
      properties: { files: [attachment] },
    });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove manual.pdf" }));

    await waitFor(() => expect(rowValue(row.id, prop.id)).toBeNull());
    await waitFor(() => expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(1));
    expect(deleteWorkspaceFile).not.toHaveBeenCalled();
    expect(evictCachedWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("keeps a retryable detach queued and evicts cache only after the retry commits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const prop = makeProp(DB_ID, { id: "files", type: "files", name: "Files" });
      seedDbProps(DB_ID, [prop]);
      const attachment = {
        id: "workspaces/ws/files/offline.pdf",
        key: "workspaces/ws/files/offline.pdf",
        name: "offline.pdf",
        url: "/api/storage/files/workspaces/ws/files/offline.pdf",
      };
      const row = makeRow(DB_ID, {
        id: "row-file-offline",
        properties: { files: [attachment] },
      });
      seedPages([row]);
      updateDatabaseRowRemote
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ ...row, properties: { files: null } });

      render(<PropertyCell row={row} prop={prop} />);
      fireEvent.click(screen.getByRole("button", { name: "Remove offline.pdf" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(rowValue(row.id, prop.id)).toBeNull();
      expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(1);
      expect(evictCachedWorkspaceFiles).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(updateDatabaseRowRemote).toHaveBeenCalledTimes(2);
      expect(evictCachedWorkspaceFiles).toHaveBeenCalledWith([attachment.key]);
      expect(deleteWorkspaceFile).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

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
    expect(screen.getByRole("group", { name: "Status" }).textContent).toContain("Todo");
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
    const group = screen.getByRole("group", { name: "Tags" });
    expect(group.textContent).toContain("Alpha");
    expect(group.textContent).toContain("Beta");
    expect(trigger.closest('[role="button"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove Beta" }));
    expect(rowValue("row-1", "tags")).toEqual(["t-a"]);
  });

  it("renders a stored date key in display format on the date trigger", () => {
    const prop = makeProp(DB_ID, { id: "due", type: "date", name: "Due" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", properties: { due: "2025-03-09" } });
    seedPages([row]);

    render(<PropertyCell row={row} prop={prop} />);
    const trigger = screen.getByRole("button", { name: /^Edit Due date/ });
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

  it("preserves an explicitly stored 'Untitled' database title", () => {
    const prop = makeProp(DB_ID, { id: "title", type: "title", name: "Name" });
    seedDbProps(DB_ID, [prop]);
    const row = makeRow(DB_ID, { id: "row-1", title: "Untitled" });
    seedPages([row]);

    const { container } = render(<PropertyCell row={row} prop={prop} />);
    const input = container.querySelector<HTMLInputElement>("[data-table-title-input]");
    expect(input).toBeTruthy();
    expect(input!.value).toBe("Untitled");
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
