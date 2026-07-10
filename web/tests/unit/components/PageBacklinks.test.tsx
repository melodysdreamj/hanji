// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    getAllBlocksRemote: vi.fn(async () => ({ blocks: [] })),
  };
});

import { PageBacklinks } from "@/components/PageBacklinks";
import { useStore } from "@/lib/store";
import type { Block } from "@/lib/types";
import { makePage, resetStore, seedPages, seedUser } from "./storeTestUtils";

function mentionBlock(id: string, targetPageId: string, text: string, position = 0): Block {
  return {
    id,
    pageId: "source",
    type: "paragraph",
    content: { rich: [{ text, mention: "page", pageId: targetPageId }] },
    position,
  };
}

function linkBlock(id: string, targetPageId: string, text: string, position = 0): Block {
  return {
    id,
    pageId: "source",
    type: "paragraph",
    content: { rich: [{ text, link: `/p/${targetPageId}` }] },
    position,
  };
}

function seedBacklinks(blocks: Block[]) {
  seedPages([
    makePage({ id: "target", title: "Target page" }),
    makePage({ id: "source", title: "Source page" }),
  ]);
  useStore.setState({
    blocksByPage: { source: blocks },
    loadedBlockPages: new Set(["source"]),
  });
}

async function flushEffects() {
  await act(async () => {});
}

beforeEach(() => {
  resetStore();
  seedUser();
  window.history.replaceState(null, "", "/");
});
afterEach(cleanup);

describe("PageBacklinks", () => {
  it("renders nothing when the page has no backlinks", async () => {
    seedBacklinks([]);
    const { container } = render(<PageBacklinks pageId="target" display="expanded" />);
    await flushEffects();
    expect(container.firstChild).toBeNull();
  });

  it("counts mentions and links and lists them when expanded", async () => {
    seedBacklinks([
      mentionBlock("b1", "target", "See Target page here", 0),
      linkBlock("b2", "target", "Linked write-up", 1),
    ]);
    render(<PageBacklinks pageId="target" display="expanded" />);
    await flushEffects();

    const toggle = screen.getByRole("button", { name: /2 backlinks/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("1 mention · 1 link")).toBeTruthy();
    expect(screen.getByText("Mention")).toBeTruthy();
    expect(screen.getByText("Link")).toBeTruthy();
    expect(screen.getByText("See Target page here")).toBeTruthy();
    expect(screen.getByText("Linked write-up")).toBeTruthy();
  });

  it("starts collapsed by default and expands on toggle click", async () => {
    seedBacklinks([mentionBlock("b1", "target", "One reference")]);
    render(<PageBacklinks pageId="target" />);
    await flushEffects();

    const toggle = screen.getByRole("button", { name: /1 backlink$/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Linked mentions")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Linked mentions")).toBeTruthy();
    expect(screen.getByText("One reference")).toBeTruthy();
  });

  it("truncates long lists to 12 and reveals the rest via the more button", async () => {
    const blocks = Array.from({ length: 14 }, (_, index) =>
      mentionBlock(`b${index}`, "target", `Reference ${index}`, index)
    );
    seedBacklinks(blocks);
    render(<PageBacklinks pageId="target" display="expanded" />);
    await flushEffects();

    expect(screen.getAllByText("Mention")).toHaveLength(12);
    const more = screen.getByRole("button", { name: "2 more backlinks" });
    fireEvent.click(more);
    expect(screen.getAllByText("Mention")).toHaveLength(14);
    expect(screen.queryByRole("button", { name: "2 more backlinks" })).toBeNull();
  });

  it("navigates to the source block and closes the sidebar when a backlink is clicked", async () => {
    seedBacklinks([mentionBlock("b1", "target", "Jump target")]);
    act(() => useStore.getState().setSidebarOpen(true));
    render(<PageBacklinks pageId="target" display="expanded" />);
    await flushEffects();

    fireEvent.click(screen.getByText("Jump target"));
    expect(window.location.pathname).toBe("/p/source");
    expect(window.location.hash).toBe("#block-b1");
    expect(useStore.getState().sidebarOpen).toBe(false);
  });
});
