// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/pageTitle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pageTitle")>();
  return { ...actual, pageDisplayTitle: vi.fn(actual.pageDisplayTitle) };
});

import { PageTreeItem } from "@/components/PageTreeItem";
import { i18next } from "@/i18n";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { useStore } from "@/lib/store";
import { makePage, resetStore, seedPages, seedUser, TEST_USER } from "./storeTestUtils";

function seedTree() {
  seedPages([
    makePage({ id: "parent", title: "Parent page", position: 0 }),
    makePage({
      id: "child",
      title: "Child page",
      parentId: "parent",
      parentType: "page",
      position: 1,
    }),
  ]);
}

beforeEach(async () => {
  await i18next.changeLanguage("en");
  vi.mocked(pageDisplayTitle).mockClear();
  resetStore();
  seedUser();
  window.history.replaceState(null, "", "/");
});
afterEach(cleanup);

describe("PageTreeItem", () => {
  it("renders a collapsed treeitem with level and disclosure state", () => {
    seedTree();
    render(<PageTreeItem pageId="parent" depth={0} />);
    const row = screen.getByRole("treeitem", { name: "Parent page" });
    expect(row.getAttribute("aria-level")).toBe("1");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "Child page" })).toBeNull();
  });

  it("uses the Korean empty-title fallback in visible and accessible tree labels", async () => {
    await i18next.changeLanguage("ko");
    seedPages([makePage({ id: "untitled", title: "", position: 0 })]);

    render(<PageTreeItem pageId="untitled" depth={0} />);

    expect(screen.getByRole("treeitem", { name: "제목 없음" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "제목 없음 펼치기" })).toBeTruthy();
  });

  it("uses one roving tab stop per tree and moves it with focus", () => {
    seedPages([
      makePage({ id: "first", title: "First", position: 0 }),
      makePage({ id: "second", title: "Second", position: 1 }),
    ]);
    render(
      <div role="tree">
        <PageTreeItem pageId="first" depth={0} index={0} setSize={2} />
        <PageTreeItem pageId="second" depth={0} index={1} setSize={2} />
      </div>
    );
    const first = screen.getByRole("treeitem", { name: "First" });
    const second = screen.getByRole("treeitem", { name: "Second" });
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);

    second.focus();
    expect(first.tabIndex).toBe(-1);
    expect(second.tabIndex).toBe(0);
  });

  it("keeps a tree tabbable when the active page belongs to a different tree", () => {
    window.history.replaceState(null, "", "/p/outside");
    seedPages([
      makePage({ id: "first", title: "First", position: 0 }),
      makePage({ id: "second", title: "Second", position: 1 }),
    ]);
    render(
      <div role="tree">
        <PageTreeItem pageId="first" depth={0} index={0} setSize={2} />
        <PageTreeItem pageId="second" depth={0} index={1} setSize={2} />
      </div>
    );
    expect(screen.getByRole("treeitem", { name: "First" }).tabIndex).toBe(0);
    expect(screen.getByRole("treeitem", { name: "Second" }).tabIndex).toBe(-1);
  });

  it("does not rerender a page row for an unrelated block-map update", () => {
    seedPages([makePage({ id: "stable", title: "Stable" })]);
    render(<PageTreeItem pageId="stable" depth={0} index={0} setSize={1} />);
    const callsAfterRender = vi.mocked(pageDisplayTitle).mock.calls.length;

    act(() => useStore.setState({ blocksByPage: { unrelated: [] } }));

    expect(vi.mocked(pageDisplayTitle)).toHaveBeenCalledTimes(callsAfterRender);
  });

  it("does not rerender when a block edit only advances page edit metadata", () => {
    seedPages([makePage({ id: "active", title: "Active" })]);
    render(<PageTreeItem pageId="active" depth={0} index={0} setSize={1} />);
    const callsAfterRender = vi.mocked(pageDisplayTitle).mock.calls.length;

    act(() =>
      useStore.setState((state) => ({
        pagesById: {
          ...state.pagesById,
          active: {
            ...state.pagesById.active,
            updatedAt: "2026-07-10T00:00:00.000Z",
            lastEditedBy: "another-editor",
          },
        },
      }))
    );

    expect(vi.mocked(pageDisplayTitle)).toHaveBeenCalledTimes(callsAfterRender);
  });

  it("is memoized: a parent re-render with a rebuilt but content-equal excludePageIds set does not re-render rows", () => {
    seedPages([makePage({ id: "stable", title: "Stable" })]);
    const { rerender } = render(
      <PageTreeItem
        pageId="stable"
        depth={0}
        index={0}
        setSize={1}
        excludePageIds={new Set(["hidden-1"])}
      />
    );
    const callsAfterRender = vi.mocked(pageDisplayTitle).mock.calls.length;

    // The sidebar rebuilds this Set whenever pagesById changes identity (every
    // editor keystroke) — content equality must keep the row memoized.
    rerender(
      <PageTreeItem
        pageId="stable"
        depth={0}
        index={0}
        setSize={1}
        excludePageIds={new Set(["hidden-1"])}
      />
    );
    expect(vi.mocked(pageDisplayTitle)).toHaveBeenCalledTimes(callsAfterRender);

    // A REAL change to the set still re-renders.
    rerender(
      <PageTreeItem
        pageId="stable"
        depth={0}
        index={0}
        setSize={1}
        excludePageIds={new Set(["hidden-2"])}
      />
    );
    expect(vi.mocked(pageDisplayTitle).mock.calls.length).toBeGreaterThan(callsAfterRender);
  });

  it("expands children on disclosure click and records the expansion in the store", () => {
    seedTree();
    render(<PageTreeItem pageId="parent" depth={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Parent page" }));

    expect(screen.getByRole("group", { name: "Parent page subpages" })).toBeTruthy();
    const child = screen.getByRole("treeitem", { name: "Child page" });
    expect(child.getAttribute("aria-level")).toBe("2");
    expect(useStore.getState().treeExpandedPageIds.has("parent")).toBe(true);
  });

  it("expands with ArrowRight and collapses with ArrowLeft", () => {
    seedTree();
    render(<PageTreeItem pageId="parent" depth={0} />);
    const row = screen.getByRole("treeitem", { name: "Parent page" });

    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: "Child page" })).toBeTruthy();

    fireEvent.keyDown(row, { key: "ArrowLeft" });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "Child page" })).toBeNull();
  });

  it("navigates to the page on Enter", () => {
    seedTree();
    render(<PageTreeItem pageId="parent" depth={0} />);
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "Parent page" }), {
      key: "Enter",
    });
    expect(window.location.pathname).toBe("/p/parent");
  });

  it("renames the page through the inline rename input", () => {
    seedTree();
    render(<PageTreeItem pageId="parent" depth={0} />);
    fireEvent.doubleClick(screen.getByRole("treeitem", { name: "Parent page" }));

    const input = screen.getByLabelText("Rename Parent page") as HTMLInputElement;
    expect(input.value).toBe("Parent page");
    fireEvent.change(input, { target: { value: "Renamed page" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useStore.getState().pagesById["parent"].title).toBe("Renamed page");
  });

  it("hides the add-subpage control when the user cannot edit the page", () => {
    seedPages([
      makePage({ id: "theirs", title: "Someone else's page", createdBy: "other-user" }),
    ]);
    render(<PageTreeItem pageId="theirs" depth={0} />);
    const row = screen.getByRole("treeitem", { name: "Someone else's page" });
    expect(row.getAttribute("draggable")).toBe("false");
    expect(
      screen.queryByRole("button", { name: "Add a page inside Someone else's page" })
    ).toBeNull();
  });

  it("shows the add-subpage control and drag affordance for an editable page", () => {
    seedPages([makePage({ id: "mine", title: "My page", createdBy: TEST_USER })]);
    render(<PageTreeItem pageId="mine" depth={0} />);
    const row = screen.getByRole("treeitem", { name: "My page" });
    expect(row.getAttribute("draggable")).toBe("true");
    expect(screen.getByRole("button", { name: "Add a page inside My page" })).toBeTruthy();
  });

  it("marks a locked page in the accessible name and lock badge", () => {
    seedPages([makePage({ id: "locked", title: "Frozen page", isLocked: true })]);
    render(<PageTreeItem pageId="locked" depth={0} />);
    expect(screen.getByRole("treeitem", { name: "Frozen page (locked)" })).toBeTruthy();
    expect(screen.getByLabelText("Locked page")).toBeTruthy();
  });

  it("renders nothing for an excluded or missing page", () => {
    seedTree();
    const { container } = render(
      <PageTreeItem pageId="parent" depth={0} excludePageIds={new Set(["parent"])} />
    );
    expect(container.firstChild).toBeNull();

    const { container: missing } = render(<PageTreeItem pageId="nope" depth={0} />);
    expect(missing.firstChild).toBeNull();
  });
});
