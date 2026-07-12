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
import { getPageBlocksRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import type { Block } from "@/lib/types";
import { makePage, resetStore, seedPages, seedUser } from "./storeTestUtils";
import {
  clipboardWithText,
  placeCaretAt,
  seedBlocks,
  textBlock,
} from "./editorTestUtils";

const PAGE_ID = "page-editor";
const getPageBlocksRemoteMock = vi.mocked(getPageBlocksRemote);

function seedEditorPage(blocks: Block[]) {
  seedPages([makePage({ id: PAGE_ID, title: "Editor page" })]);
  seedBlocks(PAGE_ID, blocks);
}

function pageBlocks() {
  return useStore.getState().topLevelBlocks(PAGE_ID);
}

beforeEach(() => {
  resetStore();
  seedUser();
  getPageBlocksRemoteMock.mockClear();
  getPageBlocksRemoteMock.mockResolvedValue({ blocks: [] });
});
afterEach(cleanup);

describe("Editor", () => {
  it("renders the seeded blocks as an ordered page body", () => {
    seedEditorPage([
      textBlock(PAGE_ID, "b2", "Second", { position: 1 }),
      textBlock(PAGE_ID, "b1", "First", { position: 0 }),
      textBlock(PAGE_ID, "b3", "Title", { type: "heading_1", position: 2 }),
    ]);
    render(<Editor pageId={PAGE_ID} skipRemoteLoad showPageStarter={false} />);

    const body = screen.getByRole("region", { name: "Page body" });
    const textboxes = Array.from(body.querySelectorAll('[data-rt-editable="true"]'));
    expect(textboxes.map((el) => el.textContent)).toEqual(["First", "Second", "Title"]);
  });

  it("shows the loading fallback, fetches blocks and renders the result", async () => {
    seedPages([makePage({ id: PAGE_ID, title: "Editor page" })]);
    getPageBlocksRemoteMock.mockResolvedValue({
      blocks: [textBlock(PAGE_ID, "remote-1", "From the server", { position: 0 })],
    });
    render(<Editor pageId={PAGE_ID} showPageStarter={false} />);

    expect(screen.getByLabelText("Loading page body")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Loading page body")).toBeNull());
    expect(getPageBlocksRemoteMock).toHaveBeenCalledWith(PAGE_ID);
    expect(screen.getByText("From the server")).toBeTruthy();
  });

  it("shows the page starter on an empty page and dismisses it once the user types", () => {
    seedEditorPage([textBlock(PAGE_ID, "empty", "", { position: 0 })]);
    render(<Editor pageId={PAGE_ID} skipRemoteLoad />);

    expect(screen.getByRole("button", { name: "Templates" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Import/ })).toBeTruthy();

    const editable = screen.getByRole("textbox", { name: "Text block text" });
    editable.textContent = "typing";
    placeCaretAt(editable, 6);
    fireEvent.input(editable);

    expect(screen.queryByRole("button", { name: "Templates" })).toBeNull();
  });

  it("does not offer the page starter in read-only mode", () => {
    seedEditorPage([textBlock(PAGE_ID, "empty", "", { position: 0 })]);
    render(<Editor pageId={PAGE_ID} skipRemoteLoad readOnly />);
    expect(screen.queryByRole("button", { name: "Templates" })).toBeNull();
  });

  it("shows a custom empty-body prompt as the placeholder when the starter is hidden", () => {
    seedEditorPage([textBlock(PAGE_ID, "empty", "", { position: 0 })]);
    render(
      <Editor
        pageId={PAGE_ID}
        skipRemoteLoad
        showPageStarter={false}
        emptyBodyPrompt="Write your update here"
      />
    );
    const editable = screen.getByRole("textbox", { name: "Text block text" });
    expect(editable.getAttribute("aria-placeholder")).toBe("Write your update here");
  });

  it("adds a new paragraph when pressing Enter at the end of the last block", async () => {
    seedEditorPage([textBlock(PAGE_ID, "b1", "Only block", { position: 0 })]);
    render(<Editor pageId={PAGE_ID} skipRemoteLoad showPageStarter={false} />);

    const editable = screen.getByRole("textbox", { name: "Text block text" });
    placeCaretAt(editable, "Only block".length);
    fireEvent.keyDown(editable, { key: "Enter" });

    await waitFor(() => expect(pageBlocks()).toHaveLength(2));
    expect(pageBlocks()[0].plainText).toBe("Only block");
    expect(pageBlocks()[1].type).toBe("paragraph");
    expect(pageBlocks()[1].plainText ?? "").toBe("");
    expect(screen.getAllByRole("textbox", { name: "Text block text" })).toHaveLength(2);
  });

  it("expands pasted markdown into structured blocks", async () => {
    seedEditorPage([textBlock(PAGE_ID, "empty", "", { position: 0 })]);
    render(<Editor pageId={PAGE_ID} skipRemoteLoad showPageStarter={false} />);

    const editable = screen.getByRole("textbox", { name: "Text block text" });
    placeCaretAt(editable, 0);
    fireEvent.paste(
      editable,
      clipboardWithText("# Title\n\n- item one\n- item two")
    );

    await waitFor(() => expect(pageBlocks()).toHaveLength(3));
    const [heading, first, second] = pageBlocks();
    expect(heading.type).toBe("heading_1");
    expect(heading.plainText).toBe("Title");
    expect(first.type).toBe("bulleted_list_item");
    expect(first.plainText).toBe("item one");
    expect(second.type).toBe("bulleted_list_item");
    expect(second.plainText).toBe("item two");
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("item one")).toBeTruthy();
  });

  it("keeps a to-do checkbox interactive but the body read-only in read-only mode", () => {
    seedEditorPage([
      textBlock(PAGE_ID, "todo", "Ship it", { type: "to_do", position: 0 }),
    ]);
    render(<Editor pageId={PAGE_ID} skipRemoteLoad readOnly />);

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    const editable = screen.getByRole("textbox", { name: "To-do list block text" });
    expect(editable.getAttribute("contenteditable")).toBe("false");
  });
});
