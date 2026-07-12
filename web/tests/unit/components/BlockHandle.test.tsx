// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    updatePageRemote: vi.fn(async () => undefined),
    updateBlockRemote: vi.fn(async () => undefined),
  };
});

import { BlockHandle } from "@/components/editor/BlockHandle";
import type { EditorOps } from "@/components/editor/Editor";
import { i18next } from "@/i18n";
import { useStore } from "@/lib/store";
import { activeDateLocale } from "@/lib/i18n";
import type { Block } from "@/lib/types";
import { resetStore, seedUser } from "./storeTestUtils";

const BLOCK: Block = {
  id: "b1",
  pageId: "page-1",
  type: "paragraph",
  content: { rich: [{ text: "Hello block" }] },
  position: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeOps(overrides: Record<string, unknown> = {}) {
  return {
    pageId: "page-1",
    readOnly: false,
    publicReadOnly: false,
    selectedBlockId: null,
    selectedBlockIds: new Set<string>(),
    blockActionMenuFor: null,
    selectBlock: vi.fn(),
    remove: vi.fn(),
    deleteSelectedBlocks: vi.fn(),
    duplicateSelectedBlocks: vi.fn(async () => [BLOCK]),
    copySelectedBlocks: vi.fn(async () => true),
    moveSelectedBlocks: vi.fn(() => true),
    changeSelectedType: vi.fn(),
    setSelectedBlockColor: vi.fn(() => true),
    insertAfter: vi.fn(),
    ...overrides,
  } as unknown as EditorOps;
}

function renderHandle({
  menuOpen = false,
  ops = makeOps(),
  block = BLOCK,
  captionControl = false,
}: { menuOpen?: boolean; ops?: EditorOps; block?: Block; captionControl?: boolean } = {}) {
  const onDragState = vi.fn();
  const onMenuOpen = vi.fn();
  const onMenuClose = vi.fn();
  render(
    <>
      {captionControl && (
        <div data-block-id={block.id}>
          <div
            role="textbox"
            tabIndex={0}
            data-testid="caption-control"
            data-block-control={`${block.type}-caption`}
          />
        </div>
      )}
      <BlockHandle
        block={block}
        ops={ops}
        dragType="application/x-hanji-block"
        onDragState={onDragState}
        menuOpen={menuOpen}
        menuAnchor={menuOpen ? { x: 20, y: 20, bottom: 40 } : null}
        onMenuOpen={onMenuOpen}
        onMenuClose={onMenuClose}
      />
    </>
  );
  return { ops, onDragState, onMenuOpen, onMenuClose };
}

beforeEach(async () => {
  await i18next.changeLanguage("en");
  resetStore();
  seedUser();
});
afterEach(cleanup);

describe("BlockHandle", () => {
  it("renders the gutter buttons with menu affordances", () => {
    renderHandle();
    const add = screen.getByRole("button", { name: "Add block below" });
    const actions = screen.getByRole("button", { name: "Open block actions" });
    expect(add.getAttribute("aria-haspopup")).toBe("menu");
    expect(add.getAttribute("aria-expanded")).toBe("false");
    expect(actions.getAttribute("aria-haspopup")).toBe("menu");
    expect(actions.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("selects the block and requests the action menu on handle click", () => {
    const { ops, onMenuOpen } = renderHandle();
    fireEvent.click(screen.getByRole("button", { name: "Open block actions" }));
    expect(ops.selectBlock).toHaveBeenCalledWith("b1");
    expect(onMenuOpen).toHaveBeenCalledTimes(1);
  });

  it("opens the add-block menu from the plus button", () => {
    const { ops } = renderHandle();
    const add = screen.getByRole("button", { name: "Add block below" });
    fireEvent.click(add);
    expect(ops.selectBlock).toHaveBeenCalledWith("b1");
    expect(add.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders the block action menu when open and deletes through it", () => {
    const { ops, onMenuClose } = renderHandle({ menuOpen: true });
    const menu = screen.getByRole("menu", { name: "Block actions" });
    expect(menu).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(ops.remove).toHaveBeenCalledWith("b1");
    expect(onMenuClose).toHaveBeenCalled();
    expect(
      useStore.getState().toasts.some((toast) => toast.message === "Deleted block")
    ).toBe(true);
  });

  it("duplicates the block and closes the menu", async () => {
    const { ops, onMenuClose } = renderHandle({ menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /Duplicate/ }));
    await waitFor(() => expect(onMenuClose).toHaveBeenCalled());
    expect(ops.duplicateSelectedBlocks).toHaveBeenCalledWith("b1");
    expect(
      useStore.getState().toasts.some((toast) => toast.message === "Duplicated block")
    ).toBe(true);
  });

  it("turns the block into a heading from the turn-into submenu", () => {
    const { ops } = renderHandle({ menuOpen: true });
    fireEvent.click(screen.getByRole("menuitem", { name: /Turn into/ }));

    const current = screen.getByRole("menuitemradio", { name: "Text" });
    expect(current.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Heading 1" }));
    expect(ops.changeSelectedType).toHaveBeenCalledWith("b1", "heading_1");
  });

  it("closes the menu on Escape", () => {
    const { onMenuClose } = renderHandle({ menuOpen: true });
    fireEvent.keyDown(screen.getByRole("menu", { name: "Block actions" }), {
      key: "Escape",
    });
    expect(onMenuClose).toHaveBeenCalledTimes(1);
  });

  it.each(["en", "ko"])(
    "focuses a newly shown image caption through its language-neutral control in %s",
    async (language) => {
      await i18next.changeLanguage(language);
      const imageBlock: Block = {
        ...BLOCK,
        type: "image",
        content: { url: "https://images.example/image.png", rich: [] },
      };
      renderHandle({ menuOpen: true, block: imageBlock, captionControl: true });

      fireEvent.click(
        screen.getByRole("menuitem", { name: i18next.t("blockHandle:menu.addCaption") })
      );

      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("caption-control")));
    }
  );

  it.each(["en", "ko"])(
    "formats the block edited date with the active language locale in %s",
    async (language) => {
      await i18next.changeLanguage(language);
      const updatedAt = "2024-01-02T15:04:00.000Z";
      const date = new Date(updatedAt);
      renderHandle({ menuOpen: true, block: { ...BLOCK, createdAt: updatedAt, updatedAt } });
      const relativeDate = date.toLocaleDateString(activeDateLocale(), {
        month: "short", day: "numeric", year: "numeric",
      });
      const fullDate = date.toLocaleString(activeDateLocale(), {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
      });
      expect(screen.getByText(i18next.t("blockHandle:edited.on", { date: relativeDate })))
        .toBeTruthy();
      expect(screen.getByTitle(i18next.t("blockHandle:edited.on", { date: fullDate })))
        .toBeTruthy();
    }
  );
});
