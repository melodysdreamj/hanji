// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    createBlockRemote: vi.fn(async () => undefined),
    createBlocksRemote: vi.fn(async () => undefined),
    updateBlockRemote: vi.fn(async () => undefined),
    updateBlocksRemote: vi.fn(async () => undefined),
    deleteBlockRemote: vi.fn(async () => undefined),
    deleteBlocksRemote: vi.fn(async () => undefined),
    updatePageRemote: vi.fn(async () => undefined),
    getPageBlocksRemote: vi.fn(async () => ({ blocks: [] })),
    listCollaborationDocumentsRemote: vi.fn(async () => []),
    listCollaborationOperationsRemote: vi.fn(async () => []),
    recordCollaborationOperationRemote: vi.fn(async () => undefined),
  };
});

import { Editor } from "@/components/editor/Editor";
import { i18next } from "@/i18n";
import { useStore } from "@/lib/store";
import type { Block } from "@/lib/types";
import { makePage, resetStore, seedPages, seedUser } from "./storeTestUtils";
import { makeBlock, placeCaretAt, seedBlocks, textBlock } from "./editorTestUtils";

const PAGE_ID = "page-blocks";

function renderEditor(blocks: Block[]) {
  seedPages([makePage({ id: PAGE_ID, title: "Block page" })]);
  seedBlocks(PAGE_ID, blocks);
  return render(<Editor pageId={PAGE_ID} skipRemoteLoad showPageStarter={false} />);
}

function pageBlocks() {
  return useStore.getState().topLevelBlocks(PAGE_ID);
}

function editableFor(label: string) {
  return screen.getByRole("textbox", { name: label }) as HTMLDivElement;
}

beforeEach(async () => {
  await i18next.changeLanguage("en");
  resetStore();
  seedUser();
});
afterEach(cleanup);

describe("BlockItem rendering", () => {
  it.each([
    ["en", "July 2026"],
    ["ko", "2026년 7월"],
  ] as const)("formats the inline mention calendar month in %s", async (language, expectedMonth) => {
    await i18next.changeLanguage(language);
    const { container } = renderEditor([
      textBlock(PAGE_ID, "date-mention", "@Jul 4, 2026", {
        position: 0,
        content: {
          rich: [{ text: "@Jul 4, 2026", mention: "date", date: "2026-07-04" }],
        },
      }),
    ]);
    const mention = container.querySelector<HTMLElement>('[data-mention="date"]');
    expect(mention).toBeTruthy();
    fireEvent.click(mention!);
    const dialog = await screen.findByRole("dialog", {
      name: i18next.t("blockItem:date.editMention"),
    });
    expect(dialog.textContent).toContain(expectedMonth);
  });

  it("sandboxes external embeds without same-origin privileges", () => {
    const { container } = renderEditor([
      makeBlock(PAGE_ID, {
        id: "embed-safe",
        type: "embed",
        position: 0,
        content: { url: "https://www.youtube.com/embed/example" },
      }),
    ]);

    const iframe = container.querySelector("iframe[data-embed-iframe='true']");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("sandbox")).toBe("allow-forms allow-popups allow-scripts");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("does not render same-origin application URLs in an embed iframe", () => {
    const { container } = renderEditor([
      makeBlock(PAGE_ID, {
        id: "embed-storage",
        type: "embed",
        position: 0,
        content: { url: `${window.location.origin}/api/storage/files/workspaces/a/payload.html` },
      }),
    ]);

    expect(container.querySelector("iframe[data-embed-iframe='true']")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Embed link" })).toBeTruthy();
  });

  it("renders paragraph and heading blocks as labelled multiline textboxes", () => {
    renderEditor([
      textBlock(PAGE_ID, "b1", "Hello world", { position: 0 }),
      textBlock(PAGE_ID, "b2", "Big title", { type: "heading_1", position: 1 }),
      textBlock(PAGE_ID, "b3", "Sub title", { type: "heading_2", position: 2 }),
    ]);

    const paragraph = editableFor("Text block text");
    expect(paragraph.textContent).toBe("Hello world");
    expect(paragraph.getAttribute("contenteditable")).toBe("true");
    expect(editableFor("Heading 1 block text").textContent).toBe("Big title");
    expect(editableFor("Heading 2 block text").textContent).toBe("Sub title");
    // The frame carries an accessible summary of the block.
    expect(screen.getByRole("group", { name: "Text block: Hello world" })).toBeTruthy();
  });

  it("names equation input and the table-of-contents and breadcrumb landmarks", () => {
    renderEditor([
      textBlock(PAGE_ID, "heading-a11y", "Accessible heading", {
        type: "heading_1",
        position: 0,
      }),
      makeBlock(PAGE_ID, {
        id: "toc-a11y",
        type: "table_of_contents",
        position: 1,
      }),
      makeBlock(PAGE_ID, {
        id: "equation-a11y",
        type: "equation",
        position: 2,
        content: { expression: "E = mc^2" },
      }),
      makeBlock(PAGE_ID, {
        id: "breadcrumb-a11y",
        type: "breadcrumb",
        position: 3,
      }),
    ]);

    expect(screen.getByRole("navigation", { name: "Table of contents" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Page breadcrumb" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Equation expression" })).toBeTruthy();
  });

  it("renders a to-do block whose checkbox commits the toggle to the store", () => {
    renderEditor([
      textBlock(PAGE_ID, "todo", "Buy milk", { type: "to_do", position: 0 }),
    ]);

    const checkbox = screen.getByRole("checkbox", {
      name: "Mark to-do as complete",
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(pageBlocks()[0].content?.checked).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Mark to-do as incomplete" })).toBeTruthy();
  });

  it("hides toggle children while collapsed and expands through the caret button", () => {
    renderEditor([
      textBlock(PAGE_ID, "tg", "Details", {
        type: "toggle",
        position: 0,
        content: { rich: [{ text: "Details" }], collapsed: true },
      }),
      textBlock(PAGE_ID, "child", "Hidden child", { parentId: "tg", position: 0 }),
    ]);

    expect(screen.queryByText("Hidden child")).toBeNull();
    const caret = screen.getByRole("button", { name: "Open toggle" });
    expect(caret.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(caret);
    expect(pageBlocks()[0].content?.collapsed).toBe(false);
    expect(screen.getByText("Hidden child")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close toggle" })).toBeTruthy();
  });

  it("offers the empty-toggle child affordance when an open toggle has no children", () => {
    renderEditor([
      textBlock(PAGE_ID, "tg", "Empty toggle", { type: "toggle", position: 0 }),
    ]);
    expect(
      screen.getByRole("button", { name: "Add a block inside this empty toggle" })
    ).toBeTruthy();
  });

  it("renders a callout with its icon button and editable text", () => {
    renderEditor([
      textBlock(PAGE_ID, "c1", "Watch out", {
        type: "callout",
        position: 0,
        content: { rich: [{ text: "Watch out" }], icon: "🚨" },
      }),
    ]);

    const icon = screen.getByRole("button", { name: "Change callout icon" });
    expect(icon.textContent).toBe("🚨");
    expect(editableFor("Callout block text").textContent).toBe("Watch out");
  });

  it("renders a code block with language select, copy button and line-number toggle", () => {
    renderEditor([
      textBlock(PAGE_ID, "code", "const x = 1;", {
        type: "code",
        position: 0,
        content: { rich: [{ text: "const x = 1;" }], language: "javascript" },
      }),
    ]);

    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Code language" })).toBeTruthy();

    const lineNumbers = screen.getByRole("button", { name: "Toggle line numbers" });
    expect(lineNumbers.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(lineNumbers);
    expect(pageBlocks()[0].content?.lineNumbers).toBe(true);
  });

  it("renders divider and quote blocks", () => {
    const { container } = renderEditor([
      makeBlock(PAGE_ID, { id: "d1", type: "divider", position: 0 }),
      textBlock(PAGE_ID, "q1", "Wise words", { type: "quote", position: 1 }),
    ]);

    expect(container.querySelector("hr")).toBeTruthy();
    expect(editableFor("Quote block text").textContent).toBe("Wise words");
  });

  it("numbers consecutive numbered list items from their sibling order", () => {
    renderEditor([
      textBlock(PAGE_ID, "n1", "first", { type: "numbered_list_item", position: 0 }),
      textBlock(PAGE_ID, "n2", "second", { type: "numbered_list_item", position: 1 }),
    ]);
    const groups = screen.getAllByRole("group", { name: /Numbered list block/ });
    expect(groups[0].textContent).toContain("1.");
    expect(groups[1].textContent).toContain("2.");
  });
});

describe("BlockItem keyboard behaviors", () => {
  it("splits a paragraph in two on Enter at the caret", async () => {
    renderEditor([textBlock(PAGE_ID, "b1", "HelloWorld", { position: 0 })]);
    const editable = editableFor("Text block text");
    placeCaretAt(editable, 5);

    fireEvent.keyDown(editable, { key: "Enter" });

    await waitFor(() => expect(pageBlocks()).toHaveLength(2));
    const [head, tail] = pageBlocks();
    expect(head.plainText).toBe("Hello");
    expect(tail.plainText).toBe("World");
    expect(tail.type).toBe("paragraph");
  });

  it("turns a heading back into a paragraph on Backspace at its start", () => {
    renderEditor([
      textBlock(PAGE_ID, "h1", "Heading text", { type: "heading_1", position: 0 }),
    ]);
    const editable = editableFor("Heading 1 block text");
    placeCaretAt(editable, 0);

    fireEvent.keyDown(editable, { key: "Backspace" });

    expect(pageBlocks()[0].type).toBe("paragraph");
  });

  it("merges a paragraph into the previous one on Backspace at its start", async () => {
    renderEditor([
      textBlock(PAGE_ID, "b1", "Hello ", { position: 0 }),
      textBlock(PAGE_ID, "b2", "world", { position: 1 }),
    ]);
    const second = screen
      .getAllByRole("textbox", { name: "Text block text" })
      .at(1) as HTMLDivElement;
    placeCaretAt(second, 0);

    fireEvent.keyDown(second, { key: "Backspace" });

    await waitFor(() => expect(pageBlocks()).toHaveLength(1));
    expect(pageBlocks()[0].plainText).toBe("Hello world");
  });

  it("opens the slash menu when the caret follows a slash and filters commands", () => {
    renderEditor([textBlock(PAGE_ID, "b1", "", { position: 0 })]);
    const editable = editableFor("Text block text");

    editable.textContent = "/head";
    placeCaretAt(editable, 5);
    fireEvent.input(editable);

    const menu = screen.getByRole("listbox", { name: "Block commands" });
    expect(menu).toBeTruthy();
    expect(screen.getByRole("option", { name: /Heading 1/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Bulleted list/ })).toBeNull();
  });

  it("closes the slash menu and selects the block on Escape", () => {
    renderEditor([textBlock(PAGE_ID, "b1", "", { position: 0 })]);
    const editable = editableFor("Text block text");
    editable.textContent = "/";
    placeCaretAt(editable, 1);
    fireEvent.input(editable);
    expect(screen.getByRole("listbox", { name: "Block commands" })).toBeTruthy();

    fireEvent.keyDown(editable, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Block commands" })).toBeNull();
  });
});

describe("BlockItem action menu", () => {
  it("opens the block action menu from the gutter handle and deletes the block", async () => {
    renderEditor([
      textBlock(PAGE_ID, "b1", "Keep me", { position: 0 }),
      textBlock(PAGE_ID, "b2", "Delete me", { position: 1 }),
    ]);

    const handles = screen.getAllByRole("button", { name: "Open block actions" });
    expect(handles).toHaveLength(2);
    fireEvent.click(handles[1]);

    const menu = screen.getByRole("menu", { name: "Block actions" });
    expect(menu).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));

    await waitFor(() => expect(pageBlocks()).toHaveLength(1));
    expect(pageBlocks()[0].plainText).toBe("Keep me");
    expect(screen.queryByRole("menu", { name: "Block actions" })).toBeNull();
  });

  it("changes the block type through the turn-into submenu", () => {
    renderEditor([textBlock(PAGE_ID, "b1", "Make me big", { position: 0 })]);

    fireEvent.click(screen.getByRole("button", { name: "Open block actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Turn into/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Heading 1" }));

    expect(pageBlocks()[0].type).toBe("heading_1");
  });

  it("does not render gutter handles in read-only mode", () => {
    seedPages([makePage({ id: PAGE_ID, title: "Block page" })]);
    seedBlocks(PAGE_ID, [textBlock(PAGE_ID, "b1", "Read only", { position: 0 })]);
    render(<Editor pageId={PAGE_ID} skipRemoteLoad readOnly />);

    expect(screen.queryByRole("button", { name: "Open block actions" })).toBeNull();
    const editable = editableFor("Text block text");
    expect(editable.getAttribute("contenteditable")).toBe("false");
    expect(editable.getAttribute("aria-readonly")).toBe("true");
  });
});
