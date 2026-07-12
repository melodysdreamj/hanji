// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    searchBlocksRemote: vi.fn(async () => ({ blocks: [] })),
    updatePageRemote: vi.fn(async () => undefined),
  };
});

import { SearchDialog } from "@/components/SearchDialog";
import { searchBlocksRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import type { Block } from "@/lib/types";
import { makePage, resetStore, seedPages, seedUser, TEST_USER } from "./storeTestUtils";

const searchBlocksRemoteMock = vi.mocked(searchBlocksRemote);

function openSearchWithPages() {
  seedPages([
    makePage({ id: "alpha", title: "Alpha roadmap", position: 0 }),
    makePage({ id: "beta", title: "Beta notes", position: 1, isFavorite: true }),
  ]);
  useStore.setState({ searchOpen: true });
}

async function flushEffects() {
  await act(async () => {});
}

async function typeQuery(value: string) {
  fireEvent.change(screen.getByRole("combobox", { name: "Quick Find" }), {
    target: { value },
  });
  await flushEffects();
}

// Remote content search is debounced (REMOTE_SEARCH_DEBOUNCE_MS = 220);
// sleep past it so the dispatched fetch and its state updates land.
async function settleRemoteSearch() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
}

beforeEach(() => {
  resetStore();
  seedUser();
  searchBlocksRemoteMock.mockClear();
  searchBlocksRemoteMock.mockResolvedValue({ blocks: [] });
});
afterEach(cleanup);

describe("SearchDialog", () => {
  it("renders nothing while closed and a modal dialog when open", async () => {
    seedPages([makePage({ id: "alpha", title: "Alpha roadmap" })]);
    const { container } = render(<SearchDialog />);
    expect(container.firstChild).toBeNull();

    act(() => useStore.getState().setSearchOpen(true));
    await flushEffects();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("option", { name: /Alpha roadmap/ })).toBeTruthy();
  });

  it("filters page results by the typed query and highlights matches", async () => {
    openSearchWithPages();
    render(<SearchDialog />);
    await flushEffects();
    expect(screen.getAllByRole("option")).toHaveLength(2);

    await typeQuery("alpha");
    const options = screen.getAllByRole("option").filter(
      (option) => option.getAttribute("data-kind") === "page"
    );
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Alpha roadmap");
    expect(options[0].querySelector("mark")?.textContent).toBe("Alpha");
  });

  it("appends remote block hits under Page content with an in-page badge", async () => {
    openSearchWithPages();
    const blockHit: Block = {
      id: "b1",
      pageId: "beta",
      type: "paragraph",
      plainText: "alpha appears inside beta",
      position: 0,
    };
    searchBlocksRemoteMock.mockResolvedValue({ blocks: [blockHit] });

    render(<SearchDialog />);
    await typeQuery("alpha");
    await settleRemoteSearch();

    expect(await screen.findByText("Page content")).toBeTruthy();
    expect(screen.getByText("in page")).toBeTruthy();
    // The preview is split across <mark> highlight spans, so match on the option.
    const blockOption = screen
      .getAllByRole("option")
      .find((option) => option.getAttribute("data-kind") === "block");
    expect(blockOption?.textContent).toContain("alpha appears inside beta");
    expect(searchBlocksRemoteMock).toHaveBeenCalledWith("alpha", 20);
  });

  it("shows an empty status when nothing matches", async () => {
    openSearchWithPages();
    render(<SearchDialog />);
    await typeQuery("zzz-no-match");
    await settleRemoteSearch();
    expect(screen.getByRole("status").textContent).toBe('No results for "zzz-no-match"');
  });

  it("closes on Escape and clears the open flag in the store", async () => {
    openSearchWithPages();
    render(<SearchDialog />);
    await flushEffects();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(useStore.getState().searchOpen).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers page creation only to users who can create workspace pages", async () => {
    openSearchWithPages();
    // No workspace in state: creation is not permitted, so no create row.
    render(<SearchDialog />);
    await typeQuery("brand new idea");
    expect(screen.queryByRole("option", { name: /New page/ })).toBeNull();
    cleanup();

    useStore.setState({
      searchOpen: true,
      workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
    });
    render(<SearchDialog />);
    await typeQuery("brand new idea");
    expect(
      screen.getByRole("option", { name: 'New page "brand new idea"' })
    ).toBeTruthy();
  });

  it("hides the create row when the query exactly matches an existing page title", async () => {
    openSearchWithPages();
    useStore.setState({
      workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
    });
    render(<SearchDialog />);
    await typeQuery("Alpha roadmap");
    expect(screen.queryByRole("option", { name: /New page/ })).toBeNull();
  });
});
