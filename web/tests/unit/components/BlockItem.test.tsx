// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { uploadWorkspaceFileMock } = vi.hoisted(() => ({
  uploadWorkspaceFileMock: vi.fn(),
}));

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

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, uploadWorkspaceFile: uploadWorkspaceFileMock };
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

function dispatchComposingSlashEnter(editable: HTMLDivElement, text: string) {
  editable.focus();
  fireEvent.compositionStart(editable, { data: text });
  editable.textContent = text;
  placeCaretAt(editable, text.length);
  fireEvent.input(editable, {
    data: text,
    inputType: "insertCompositionText",
    isComposing: true,
  });
  fireEvent.keyDown(editable, {
    key: "Enter",
    code: "Enter",
    keyCode: 229,
    which: 229,
    isComposing: true,
  });
  fireEvent.compositionEnd(editable, { data: text });
}

function dispatchProcessSlashEnterWithoutCompositionLifecycle(
  editable: HTMLDivElement,
  text: string
) {
  editable.focus();
  editable.textContent = text;
  placeCaretAt(editable, text.length);
  fireEvent.input(editable, {
    data: text,
    inputType: "insertText",
  });
  fireEvent.keyDown(editable, {
    key: "Process",
    code: "",
    keyCode: 229,
    which: 229,
    isComposing: true,
  });
}

function dispatchSlashParagraphBeforeInput(editable: HTMLDivElement, text: string) {
  editable.focus();
  editable.textContent = text;
  placeCaretAt(editable, text.length);
  fireEvent.input(editable, {
    data: text,
    inputType: "insertText",
  });
  fireEvent(
    editable,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
    })
  );
}

function dispatchSlashEnterBeforeMenuStateSettles(
  editable: HTMLDivElement,
  text: string
) {
  editable.focus();
  editable.textContent = text;
  placeCaretAt(editable, text.length);
  fireEvent.keyDown(editable, {
    key: "Enter",
    code: "Enter",
  });
}

beforeEach(async () => {
  await i18next.changeLanguage("en");
  resetStore();
  seedUser();
  uploadWorkspaceFileMock.mockReset();
  uploadWorkspaceFileMock.mockImplementation(async (file: File) => ({
    key: `blocks/${file.name}`,
    url: `/api/storage/files/${file.name}`,
    name: file.name,
    type: file.type,
    size: file.size,
  }));
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

  it("selects a preceding embed after removing its empty paragraph, then deletes it", async () => {
    const { container } = renderEditor([
      makeBlock(PAGE_ID, {
        id: "embed-before-empty",
        type: "embed",
        position: 0,
        content: { url: "https://example.com/embed" },
      }),
      textBlock(PAGE_ID, "empty-after-embed", "", { position: 1 }),
    ]);
    const emptyParagraph = editableFor("Text block text");
    placeCaretAt(emptyParagraph, 0);

    fireEvent.keyDown(emptyParagraph, { key: "Backspace" });

    await waitFor(() => expect(pageBlocks().map((block) => block.id)).toEqual(["embed-before-empty"]));
    const selectedEmbed = container.querySelector<HTMLElement>(
      '[data-block-id="embed-before-empty"] [data-selected="true"]'
    );
    expect(selectedEmbed).toBeTruthy();

    fireEvent.keyDown(selectedEmbed!, { key: "Backspace" });

    await waitFor(() =>
      expect(pageBlocks().some((block) => block.id === "embed-before-empty")).toBe(false)
    );
    expect(pageBlocks()).toHaveLength(1);
    expect(pageBlocks()[0].type).toBe("paragraph");
    expect(pageBlocks()[0].plainText ?? "").toBe("");
  });

  it("selects a preceding non-text block without deleting a non-empty paragraph", () => {
    const { container } = renderEditor([
      makeBlock(PAGE_ID, {
        id: "divider-before-text",
        type: "divider",
        position: 0,
      }),
      textBlock(PAGE_ID, "text-after-divider", "Keep this text", { position: 1 }),
    ]);
    const paragraph = editableFor("Text block text");
    placeCaretAt(paragraph, 0);

    fireEvent.keyDown(paragraph, { key: "Backspace" });

    expect(pageBlocks().map((block) => block.id)).toEqual([
      "divider-before-text",
      "text-after-divider",
    ]);
    expect(pageBlocks()[1].plainText).toBe("Keep this text");
    expect(
      container.querySelector('[data-block-id="divider-before-text"] [data-selected="true"]')
    ).toBeTruthy();
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

  it("keeps a blurred block's slash menu from owning Enter in the active block", async () => {
    renderEditor([
      textBlock(PAGE_ID, "blurred-slash", "", { position: 0 }),
      textBlock(PAGE_ID, "active-slash", "", { position: 1 }),
    ]);
    const [blurred, active] = screen.getAllByRole("textbox", {
      name: "Text block text",
    }) as HTMLDivElement[];

    blurred.focus();
    blurred.textContent = "/h1";
    placeCaretAt(blurred, 3);
    fireEvent.input(blurred);
    expect(screen.getAllByRole("listbox", { name: "Block commands" })).toHaveLength(1);

    active.focus();
    active.textContent = "/h2";
    placeCaretAt(active, 3);
    fireEvent.input(active);
    fireEvent.keyDown(active, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(pageBlocks().find((block) => block.id === "active-slash")?.type).toBe("heading_2")
    );
    expect(pageBlocks().find((block) => block.id === "blurred-slash")?.type).toBe("paragraph");
    expect(pageBlocks().find((block) => block.id === "blurred-slash")?.plainText).toBe("/h1");
  });

  it.each([
    ["heading", "/h1", "heading_1"],
    ["list", "/todo", "to_do"],
    ["simple table", "/table", "simple_table"],
    ["divider", "/divider", "divider"],
  ] as const)("applies the default %s slash command when Enter commits composition", async (_label, query, type) => {
    renderEditor([textBlock(PAGE_ID, "composing-slash", "", { position: 0 })]);

    dispatchComposingSlashEnter(editableFor("Text block text"), query);

    await waitFor(() => expect(pageBlocks().find((block) => block.id === "composing-slash")?.type).toBe(type));
    expect((pageBlocks().find((block) => block.id === "composing-slash")?.plainText ?? "").trim()).toBe("");
    expect(pageBlocks().some((block) => block.plainText?.includes(query))).toBe(false);
  });

  it.each([
    ["/h1", "heading_1"],
    ["/h2", "heading_2"],
    ["/h3", "heading_3"],
    ["/h4", "heading_4"],
  ] as const)(
    "applies %s directly from an ambiguous IME process key",
    async (query, type) => {
      renderEditor([textBlock(PAGE_ID, "process-slash", "", { position: 0 })]);

      dispatchProcessSlashEnterWithoutCompositionLifecycle(
        editableFor("Text block text"),
        query
      );

      await waitFor(() =>
        expect(pageBlocks().find((block) => block.id === "process-slash")?.type).toBe(type)
      );
      expect(pageBlocks().some((block) => block.plainText?.includes(query))).toBe(false);
    }
  );

  it("applies the visible slash command from paragraph beforeinput when keydown is unusable", async () => {
    renderEditor([textBlock(PAGE_ID, "beforeinput-slash", "", { position: 0 })]);

    dispatchSlashParagraphBeforeInput(editableFor("Text block text"), "/h1");

    await waitFor(() =>
      expect(pageBlocks().find((block) => block.id === "beforeinput-slash")?.type).toBe("heading_1")
    );
  });

  it.each([
    ["/h1", "heading_1"],
    ["/h2", "heading_2"],
    ["/h3", "heading_3"],
    ["/h4", "heading_4"],
  ] as const)(
    "applies %s from committed DOM even before the slash menu state settles",
    async (query, type) => {
      renderEditor([textBlock(PAGE_ID, "stale-slash-state", "", { position: 0 })]);

      dispatchSlashEnterBeforeMenuStateSettles(
        editableFor("Text block text"),
        query
      );

      await waitFor(() =>
        expect(pageBlocks().find((block) => block.id === "stale-slash-state")?.type).toBe(type)
      );
      expect(pageBlocks().some((block) => block.plainText?.includes(query))).toBe(false);
    }
  );

  it("preserves residual text and inserts media when Enter commits a slash composition", async () => {
    renderEditor([textBlock(PAGE_ID, "composing-media", "", { position: 0 })]);

    dispatchComposingSlashEnter(editableFor("Text block text"), "world /image");

    await waitFor(() => expect(pageBlocks().map((block) => block.type)).toEqual(["paragraph", "image"]));
    expect(pageBlocks()[0].plainText?.trim()).toBe("world");
    expect(pageBlocks().some((block) => block.plainText?.includes("/image"))).toBe(false);
  });

  it("opens pickers and applies actions when Enter commits a slash composition", async () => {
    renderEditor([
      textBlock(PAGE_ID, "composing-database", "", { position: 0 }),
      textBlock(PAGE_ID, "composing-color", "", { position: 1 }),
    ]);

    const [databaseEditable, colorEditable] = screen.getAllByRole("textbox", {
      name: "Text block text",
    }) as HTMLDivElement[];
    dispatchComposingSlashEnter(databaseEditable, "/database");
    expect(await screen.findByRole("dialog", { name: "Choose database source" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    dispatchComposingSlashEnter(colorEditable, "/red");

    await waitFor(() => {
      expect(pageBlocks().find((block) => block.id === "composing-color")?.content?.color).toBe("red");
    });
    expect(pageBlocks().find((block) => block.id === "composing-database")?.plainText ?? "").toBe("");
    expect(pageBlocks().find((block) => block.id === "composing-color")?.plainText ?? "").toBe("");
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

describe("Editor external file drops", () => {
  function transfer(files: File[]) {
    return { types: ["Files"], files, dropEffect: "none" } as unknown as DataTransfer;
  }

  function dispatchFileDrag(
    target: HTMLElement,
    type: "dragover" | "drop",
    dataTransfer: DataTransfer,
    clientY: number
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      dataTransfer: { value: dataTransfer },
      clientY: { value: clientY },
    });
    fireEvent(target, event);
  }

  function rect(top: number, bottom: number, left = 100, right = 700): DOMRect {
    return {
      x: left,
      y: top,
      top,
      bottom,
      left,
      right,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({}),
    };
  }

  it("replaces an empty paragraph and exposes upload progress while the file is in flight", async () => {
    let resolveUpload!: (value: {
      key: string;
      url: string;
      name: string;
      type: string;
      size: number;
    }) => void;
    uploadWorkspaceFileMock.mockImplementation(
      (
        file: File,
        _scope: string,
        _target: unknown,
        options?: { onProgress?: (progress: { phase: "uploading"; percent: number }) => void }
      ) => {
        options?.onProgress?.({ phase: "uploading", percent: 42 });
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      }
    );

    const { container } = renderEditor([textBlock(PAGE_ID, "drop-empty", "", { position: 0 })]);
    const row = container.querySelector<HTMLElement>('[data-block-id="drop-empty"] > [data-type]')!;
    row.getBoundingClientRect = () => rect(100, 132);
    const file = new File(["installer"], "dragged-installer.dmg", {
      type: "application/x-apple-diskimage",
    });
    const dataTransfer = transfer([file]);

    fireEvent.dragOver(row, { dataTransfer, clientY: 116 });
    expect(row.dataset.fileDrop).toBe("replace");
    fireEvent.drop(row, { dataTransfer, clientY: 116 });

    await waitFor(() => {
      expect(container.querySelector('[data-editor-file-upload="drop-empty"]')).toBeTruthy();
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");

    resolveUpload({
      key: "blocks/files/dragged-installer.dmg",
      url: "/api/storage/files/dragged-installer.dmg",
      name: file.name,
      type: file.type,
      size: file.size,
    });
    await waitFor(() => {
      expect(pageBlocks()[0].type).toBe("file");
      expect(pageBlocks()[0].content?.fileName).toBe(file.name);
      expect(container.querySelector("[data-editor-file-upload]")).toBeNull();
    });
  });

  it("shows a boundary line on blank canvas and preserves multi-file insertion order", async () => {
    const { container } = renderEditor([
      textBlock(PAGE_ID, "drop-before", "Before", { position: 1 }),
      textBlock(PAGE_ID, "drop-after", "After", { position: 2 }),
    ]);
    const editor = container.querySelector<HTMLElement>("[data-editor-page]")!;
    const tail = container.querySelector<HTMLElement>("[data-editor-tail]")!;
    const beforeRow = container.querySelector<HTMLElement>('[data-block-id="drop-before"] > [data-type]')!;
    const afterRow = container.querySelector<HTMLElement>('[data-block-id="drop-after"] > [data-type]')!;
    editor.getBoundingClientRect = () => rect(0, 700, 100, 700);
    beforeRow.getBoundingClientRect = () => rect(100, 132);
    afterRow.getBoundingClientRect = () => rect(180, 212);

    const image = new File(["image"], "dragged-image.png", { type: "image/png" });
    const document = new File(["document"], "dragged-notes.pdf", { type: "application/pdf" });
    const dataTransfer = transfer([image, document]);
    dispatchFileDrag(tail, "dragover", dataTransfer, 150);
    const indicator = container.querySelector<HTMLElement>("[data-editor-file-drop-indicator]");
    expect(indicator?.dataset.editorFileDropIndicator).toBe("after");
    expect(indicator?.style.top).toBe("132px");

    dispatchFileDrag(tail, "drop", dataTransfer, 150);
    await waitFor(() => {
      expect(pageBlocks().map((block) => block.content?.fileName ?? block.plainText)).toEqual([
        "Before",
        "dragged-image.png",
        "dragged-notes.pdf",
        "After",
      ]);
    });
    expect(pageBlocks().map((block) => block.type)).toEqual(["paragraph", "image", "file", "paragraph"]);
    expect(container.querySelector("[data-editor-file-drop-indicator]")).toBeNull();
  });

  it("removes only a newly inserted placeholder when its upload fails", async () => {
    uploadWorkspaceFileMock.mockRejectedValueOnce(new Error("synthetic upload failure"));
    const { container } = renderEditor([
      textBlock(PAGE_ID, "drop-anchor", "Keep this block", { position: 1 }),
      textBlock(PAGE_ID, "drop-following", "Keep this too", { position: 2 }),
    ]);
    const anchor = container.querySelector<HTMLElement>(
      '[data-block-id="drop-anchor"] > [data-type]'
    )!;
    anchor.getBoundingClientRect = () => rect(100, 140);
    const file = new File(["failed"], "failed.pdf", { type: "application/pdf" });

    fireEvent.drop(anchor, { dataTransfer: transfer([file]), clientY: 135 });

    await waitFor(() => expect(uploadWorkspaceFileMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(pageBlocks().map((block) => block.plainText)).toEqual([
        "Keep this block",
        "Keep this too",
      ]);
    });
  });

  it("does not advertise or accept external file drops in read-only pages", () => {
    seedPages([makePage({ id: PAGE_ID, title: "Read-only drop page" })]);
    seedBlocks(PAGE_ID, [textBlock(PAGE_ID, "read-only-drop", "Protected", { position: 0 })]);
    const { container } = render(
      <Editor pageId={PAGE_ID} skipRemoteLoad showPageStarter={false} readOnly />
    );
    const row = container.querySelector<HTMLElement>(
      '[data-block-id="read-only-drop"] > [data-type]'
    )!;
    row.getBoundingClientRect = () => rect(100, 140);
    const file = new File(["blocked"], "blocked.pdf", { type: "application/pdf" });
    const dataTransfer = transfer([file]);

    fireEvent.dragOver(row, { dataTransfer, clientY: 135 });
    fireEvent.drop(row, { dataTransfer, clientY: 135 });

    expect(row.dataset.fileDrop).toBeUndefined();
    expect(uploadWorkspaceFileMock).not.toHaveBeenCalled();
    expect(pageBlocks().map((block) => block.plainText)).toEqual(["Protected"]);
  });
});
