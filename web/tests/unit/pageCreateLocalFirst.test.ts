// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    createBlockRemote: vi.fn(async (block) => block),
    createPageRemote: vi.fn(async (page) => page),
    updatePageRemote: vi.fn(async () => undefined),
  };
});

import {
  createBlockRemote,
  createPageRemote,
  updatePageRemote,
} from "@/lib/edgebase";
import { flushAllPending, useStore } from "@/lib/store";
import type { Page } from "@/lib/types";
import {
  resetStore,
  seedUser,
  TEST_USER,
} from "./components/storeTestUtils";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function terminal(status = 403) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

async function settleMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetStore();
  seedUser();
  useStore.setState({
    workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
  });
  window.history.replaceState(null, "", "/p/origin");
});

afterEach(async () => {
  await flushAllPending();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("local-first page creation", () => {
  it("returns before the server and keeps title/block writes behind the page create", async () => {
    const gate = deferred<Page>();
    const events: string[] = [];
    vi.mocked(createPageRemote).mockImplementationOnce(async (page) => {
      events.push("page:start");
      const persisted = await gate.promise;
      events.push("page:end");
      return persisted ?? page;
    });
    vi.mocked(createBlockRemote).mockImplementationOnce(async (block) => {
      events.push("block:create");
      return block;
    });
    vi.mocked(updatePageRemote).mockImplementationOnce(async () => {
      events.push("page:update");
      return undefined;
    });

    const created = await useStore.getState().createPage({
      parentId: null,
      parentType: "workspace",
    });

    expect(useStore.getState().pagesById[created.id]).toEqual(created);
    expect(createPageRemote).not.toHaveBeenCalled();

    useStore.getState().updatePage(created.id, { title: "Typed immediately" });
    const block = await useStore.getState().createBlock({
      pageId: created.id,
      position: 1,
      type: "paragraph",
      content: { rich: [{ text: "First block" }] },
    });
    expect(useStore.getState().blocksByPage[created.id]).toContainEqual(block);
    expect(updatePageRemote).not.toHaveBeenCalled();
    expect(createBlockRemote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["page:start"]);

    gate.resolve({ ...created, title: "" });
    await settleMicrotasks();

    expect(events[0]).toBe("page:start");
    expect(events.indexOf("page:end")).toBeGreaterThan(0);
    expect(events.indexOf("page:update")).toBeGreaterThan(events.indexOf("page:end"));
    expect(events.indexOf("block:create")).toBeGreaterThan(events.indexOf("page:end"));
    expect(useStore.getState().pagesById[created.id]?.title).toBe("Typed immediately");
  });

  it("rolls back a terminal background rejection and restores the prior route", async () => {
    vi.mocked(createPageRemote).mockRejectedValueOnce(terminal());
    const created = await useStore.getState().createPage({
      parentId: null,
      parentType: "workspace",
    });
    window.history.pushState(null, "", `/p/${created.id}`);

    await vi.advanceTimersByTimeAsync(0);
    await settleMicrotasks();

    expect(useStore.getState().pagesById[created.id]).toBeUndefined();
    expect(window.location.pathname).toBe("/p/origin");
  });

  it("does not create a child page remotely before its optimistic parent", async () => {
    const parentGate = deferred<Page>();
    const calls: string[] = [];
    vi.mocked(createPageRemote).mockImplementation(async (page) => {
      calls.push(page.parentId ? "child" : "parent");
      if (!page.parentId) return parentGate.promise;
      return page;
    });

    const parent = await useStore.getState().createPage({
      parentId: null,
      parentType: "workspace",
    });
    await useStore.getState().createPage({
      parentId: parent.id,
      parentType: "page",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["parent"]);

    parentGate.resolve(parent);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await settleMicrotasks();
    expect(calls).toEqual(["parent", "child"]);
  });
});
