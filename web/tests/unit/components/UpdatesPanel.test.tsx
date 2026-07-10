// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    getAllBlocksRemote: vi.fn(async () => ({ blocks: [] })),
    getPageCommentsRemote: vi.fn(async (pageId: string) => ({ pageId, comments: [] })),
    updatePageRemote: vi.fn(async () => undefined),
  };
});

import { UpdatesPanel } from "@/components/UpdatesPanel";
import { getPageCommentsRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import type { Comment } from "@/lib/types";
import { makePage, resetStore, seedPages, seedUser } from "./storeTestUtils";

const NOW = new Date().toISOString();

function seedActivities() {
  seedPages([
    makePage({ id: "p1", title: "Spec page", updatedAt: NOW }),
    makePage({ id: "p2", title: "Notes page", updatedAt: NOW }),
  ]);
  const comment: Comment = {
    id: "c1",
    pageId: "p1",
    blockId: null,
    parentId: null,
    authorId: "user-other",
    body: { rich: [{ text: "Looks good" }] },
    resolved: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
  useStore.setState({
    commentsByPage: { p1: [comment] },
    loadedCommentPages: new Set(["p1", "p2"]),
  });
  // loadComments refreshes SWR-style even for already-loaded pages, so the
  // remote mock must serve the seeded comment or the refetch would wipe it.
  vi.mocked(getPageCommentsRemote).mockImplementation(async (pageId: string) => ({
    pageId,
    comments: pageId === "p1" ? [comment] : [],
  }));
}

async function flushEffects() {
  await act(async () => {});
}

async function renderPanel(props: Partial<Parameters<typeof UpdatesPanel>[0]> = {}) {
  const onClose = vi.fn();
  render(<UpdatesPanel onClose={onClose} {...props} />);
  await flushEffects();
  return { onClose };
}

// The panel refreshes its read-state (React state) inside requestAnimationFrame;
// run frames synchronously so those updates land inside act().
const realRequestAnimationFrame = window.requestAnimationFrame;

beforeEach(() => {
  resetStore();
  seedUser();
  window.requestAnimationFrame = (cb) => {
    cb(0);
    return 0;
  };
});
afterEach(() => {
  cleanup();
  window.requestAnimationFrame = realRequestAnimationFrame;
});

describe("UpdatesPanel", () => {
  it("renders a tablist with all five filters and All selected", async () => {
    seedActivities();
    await renderPanel();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "All3",
      "Unread3",
      "Comments1",
      "Mentions0",
      "Edits2",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
  });

  it("lists comment and edit activities with their badges", async () => {
    seedActivities();
    await renderPanel();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("Comment")).toBeTruthy();
    expect(screen.getAllByText("Edited")).toHaveLength(2);
    expect(screen.getByText("Looks good")).toBeTruthy();
  });

  it("filters the list when the Comments tab is clicked", async () => {
    seedActivities();
    await renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: /Comments/ }));
    expect(screen.getByRole("tab", { name: /Comments/ }).getAttribute("aria-selected")).toBe(
      "true"
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("Comment");
    expect(items[0].textContent).toContain("Spec page");
  });

  it("moves the selected tab with ArrowRight", async () => {
    seedActivities();
    await renderPanel();
    fireEvent.keyDown(screen.getByRole("tab", { name: /All/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Unread/ }).getAttribute("aria-selected")).toBe(
      "true"
    );
  });

  it("marks everything read, zeroing the unread count and disabling the button", async () => {
    seedActivities();
    await renderPanel();
    expect(screen.getByText("3 unread of 3 updates")).toBeTruthy();

    const markAll = screen.getByRole("button", { name: "Mark all updates as read" });
    expect((markAll as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(markAll);

    expect(screen.getByText("3 recent updates")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Unread/ }).textContent).toBe("Unread0");
    expect((markAll as HTMLButtonElement).disabled).toBe(true);
  });

  it("invokes onClose from the close button", async () => {
    seedActivities();
    const { onClose } = await renderPanel();
    // The backdrop shares the accessible name, so scope to the panel dialog.
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Close updates" })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an empty status when there are no activities", async () => {
    await renderPanel();
    expect(screen.getByRole("status").textContent).toBe("No updates yet.");
  });

  it("renders page history mode without the Unread tab and with disabled version nav", async () => {
    seedActivities();
    await renderPanel({ pageId: "p1" });
    expect(screen.getByText("Page history")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.queryByRole("tab", { name: /Unread/ })).toBeNull();
    expect(screen.getByText("Current version only")).toBeTruthy();

    const previous = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(true);
  });
});
