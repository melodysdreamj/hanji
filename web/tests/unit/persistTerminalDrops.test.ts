// @vitest-environment jsdom
//
// Terminal persist rejections must reconcile local optimistic state instead
// of leaving phantoms: a dropped comment create rolls back (finding: phantom
// optimistic comment), 413 (materialization cap) is terminal not retried, and
// dropped view/property/template updates force a schema reload.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in terminal drop test.");
    }),
    createBlockRemote: vi.fn(async () => undefined),
    createCommentRemote: vi.fn(async () => undefined),
    getDatabaseSnapshotRemote: vi.fn(async () => ({
      databaseId: "db",
      properties: [],
      views: [],
      templates: [],
    })),
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updatePropertyRemote: vi.fn(async () => undefined),
    updateTemplateRemote: vi.fn(async () => undefined),
    updateViewRemote: vi.fn(async () => undefined),
  };
});

import {
  createBlockRemote,
  createCommentRemote,
  getDatabaseSnapshotRemote,
  updatePropertyRemote,
  updateTemplateRemote,
  updateViewRemote,
} from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import type { DbTemplate, DbView } from "@/lib/types";
import { makePage, makeProp, resetStore, seedDbProps, seedPages, seedUser } from "./components/storeTestUtils";

const NOW = new Date(0).toISOString();
const PAST_RETRY_MS = 2500;

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function makeView(overrides: Partial<DbView> & { id: string }): DbView {
  return {
    databaseId: "db",
    name: "View",
    type: "table",
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as DbView;
}

function makeTemplate(overrides: Partial<DbTemplate> & { id: string }): DbTemplate {
  return {
    databaseId: "db",
    name: "Template",
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as DbTemplate;
}

function hasToast(needle: string) {
  return useStore.getState().toasts.some((toast) => toast.message.includes(needle));
}

async function flushMicrotasks(times = 25) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetStore();
  seedUser();
  seedPages([makePage({ id: "p1", title: "Page" })]);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("addComment terminal drop", () => {
  it("returns the optimistic comment immediately and rolls it back after a terminal drop", async () => {
    vi.mocked(createCommentRemote).mockRejectedValue(httpError(403));

    const comment = await useStore.getState().addComment("p1", "hello");
    expect(useStore.getState().commentsByPage.p1).toContainEqual(comment);

    await vi.advanceTimersByTimeAsync(0);

    expect(useStore.getState().commentsByPage.p1 ?? []).toHaveLength(0);
    expect(hasToast("edit access")).toBe(true);
  });

  it("keeps the optimistic comment on a transient failure (queued, not dropped)", async () => {
    vi.mocked(createCommentRemote).mockRejectedValue(new Error("network down"));

    const comment = await useStore.getState().addComment("p1", "hello");

    expect(comment.body).toEqual({ rich: [{ text: "hello" }] });
    expect(useStore.getState().commentsByPage.p1?.map((item) => item.id)).toEqual([comment.id]);
  });
});

describe("413 is a terminal persist status", () => {
  it("stops retrying and notifies on a 413 create failure", async () => {
    vi.mocked(createBlockRemote).mockRejectedValue(httpError(413));

    await useStore.getState().createBlock({ pageId: "p1", position: 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.mocked(createBlockRemote)).toHaveBeenCalledTimes(1);
    expect(hasToast("couldn't be saved")).toBe(true);
    await vi.advanceTimersByTimeAsync(PAST_RETRY_MS * 2);
    expect(vi.mocked(createBlockRemote)).toHaveBeenCalledTimes(1);
  });
});

describe("dropped DB schema mutations force-reload the schema", () => {
  beforeEach(() => {
    seedPages([makePage({ id: "db", kind: "database", title: "Tasks" })]);
    seedDbProps("db", [makeProp("db", { id: "prop-1", type: "text", name: "Local name" })]);
    useStore.setState({
      viewsByDb: { db: [makeView({ id: "view-1", name: "Server name" })] },
      templatesByDb: { db: [makeTemplate({ id: "template-1", name: "Server template" })] },
    });
  });

  it("updateView: reconciles the optimistic view from the server on dropped", async () => {
    vi.mocked(updateViewRemote).mockRejectedValue(httpError(403));
    vi.mocked(getDatabaseSnapshotRemote).mockResolvedValue({
      databaseId: "db",
      properties: [],
      views: [makeView({ id: "view-1", name: "Server name" })],
      templates: [],
    });

    useStore.getState().updateView("view-1", { name: "Local rename" });
    expect(useStore.getState().viewsByDb.db[0].name).toBe("Local rename");

    await flushMicrotasks();
    expect(vi.mocked(getDatabaseSnapshotRemote)).toHaveBeenCalledTimes(1);
    expect(useStore.getState().viewsByDb.db[0].name).toBe("Server name");
  });

  it("updateProperty: reconciles the optimistic property from the server on dropped", async () => {
    vi.mocked(updatePropertyRemote).mockRejectedValue(httpError(404));
    vi.mocked(getDatabaseSnapshotRemote).mockResolvedValue({
      databaseId: "db",
      properties: [makeProp("db", { id: "prop-1", type: "text", name: "Server name" })],
      views: [],
      templates: [],
    });

    useStore.getState().updateProperty("prop-1", { name: "Local rename" });
    expect(useStore.getState().propsByDb.db[0].name).toBe("Local rename");

    await flushMicrotasks();
    expect(vi.mocked(getDatabaseSnapshotRemote)).toHaveBeenCalledTimes(1);
    expect(useStore.getState().propsByDb.db[0].name).toBe("Server name");
  });

  it("updateTemplate: reconciles the optimistic template from the server on dropped", async () => {
    vi.mocked(updateTemplateRemote).mockRejectedValue(httpError(403));
    vi.mocked(getDatabaseSnapshotRemote).mockResolvedValue({
      databaseId: "db",
      properties: [],
      views: [],
      templates: [makeTemplate({ id: "template-1", name: "Server template" })],
    });

    useStore.getState().updateTemplate("template-1", { name: "Local rename" });
    expect(useStore.getState().templatesByDb.db[0].name).toBe("Local rename");

    await flushMicrotasks();
    expect(vi.mocked(getDatabaseSnapshotRemote)).toHaveBeenCalledTimes(1);
    expect(useStore.getState().templatesByDb.db[0].name).toBe("Server template");
  });
});
