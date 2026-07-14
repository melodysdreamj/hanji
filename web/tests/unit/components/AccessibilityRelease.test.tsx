// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const localLockMocks = vi.hoisted(() => ({
  localLockPending: vi.fn(() => true),
  skipLocalLock: vi.fn(),
  unlockLocalData: vi.fn(async () => "ok" as const),
}));

vi.mock("@/lib/localLock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/localLock")>()),
  ...localLockMocks,
}));

vi.mock("@/lib/edgebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edgebase")>()),
  getPageCommentsRemote: vi.fn(async () => ({ comments: [] })),
  updatePageRemote: vi.fn(async () => undefined),
}));

import { CommentsPanel } from "@/components/CommentsPanel";
import LocalLockGate from "@/components/LocalLockGate";
import { NotionImportOnboardingDialog } from "@/components/NotionImportOnboardingDialog";
import { PageHeader } from "@/components/PageHeader";
import { RowMenu } from "@/components/RowMenu";
import { WorkspaceCreateDialog } from "@/components/WorkspaceCreateDialog";
import { useStore } from "@/lib/store";
import { makePage, resetStore, seedPages, seedUser } from "./storeTestUtils";

const PAGE_ID = "page-accessibility";

beforeEach(() => {
  vi.clearAllMocks();
  localLockMocks.localLockPending.mockReturnValue(true);
  resetStore();
  seedUser();
  seedPages([makePage({ id: PAGE_ID, title: "Accessibility page" })]);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("release accessibility modal contracts", () => {
  it("names and isolates the local lock, traps both Tab directions, and restores focus", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Before lock";
    document.body.append(opener);
    opener.focus();

    const result = render(<LocalLockGate userId="user-accessibility" />);
    const dialog = screen.getByRole("dialog", { name: "Unlock local data" });
    const passphrase = screen.getByLabelText("Passphrase");
    const skip = screen.getByRole("button", { name: "Continue online only" });

    await waitFor(() => expect(document.activeElement).toBe(passphrase));
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(result.container.inert).toBe(true);
    expect(result.container.getAttribute("aria-hidden")).toBe("true");

    skip.focus();
    fireEvent.keyDown(skip, { key: "Tab" });
    expect(document.activeElement).toBe(passphrase);
    passphrase.focus();
    fireEvent.keyDown(passphrase, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(skip);

    fireEvent.click(skip);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unlock local data" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(result.container.inert).not.toBe(true);
    expect(result.container.hasAttribute("aria-hidden")).toBe(false);
  });

  it("traps and restores the workspace-create dialog opened from a real trigger", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open workspace creator</button>
          {open ? (
            <WorkspaceCreateDialog
              onClose={() => setOpen(false)}
              onCreate={async () => ({ id: "ws-new", name: "New workspace" }) as never}
            />
          ) : null}
        </>
      );
    }

    const result = render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open workspace creator" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(result.container.inert).toBe(true);

    const close = within(dialog).getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New workspace" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("names, isolates, and restores the one-time Notion import prompt", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open Notion onboarding</button>
          {open ? (
            <NotionImportOnboardingDialog
              onImport={() => setOpen(false)}
              onLater={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }

    const result = render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open Notion onboarding" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Bring your Notion workspace to Hanji?" });
    const primary = within(dialog).getByRole("button", { name: "Import from Notion" });

    await waitFor(() => expect(document.activeElement).toBe(primary));
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(result.container.inert).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", {
      name: "Bring your Notion workspace to Hanji?",
    })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("keeps a server-confirmed workspace create visibly busy and non-dismissible", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const onCreate = vi.fn(async () => {
      await createGate;
      return { id: "ws-new", name: "New workspace" } as never;
    });

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <WorkspaceCreateDialog
          onClose={() => setOpen(false)}
          onCreate={async (input) => {
            const workspace = await onCreate(input);
            setOpen(false);
            return workspace;
          }}
        />
      ) : null;
    }

    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create workspace" }));

    await waitFor(() => expect(dialog.getAttribute("aria-busy")).toBe("true"));
    expect((within(dialog).getByRole("button", { name: "Creating…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBe(dialog);
    expect(onCreate).toHaveBeenCalledTimes(1);

    releaseCreate();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New workspace" })).toBeNull());
  });

  it("keeps page duplication visible and single-flight until the server result arrives", async () => {
    const source = makePage({ id: PAGE_ID, kind: "database", title: "Source page" });
    const copy = makePage({
      id: "page-copy",
      kind: "database",
      title: "Source page copy",
      parentId: "database-parent",
      parentType: "database",
    });
    seedPages([source]);
    let releaseDuplicate!: () => void;
    const duplicateGate = new Promise<void>((resolve) => {
      releaseDuplicate = resolve;
    });
    const duplicatePage = vi.fn(async () => {
      await duplicateGate;
      return copy;
    });
    useStore.setState({ duplicatePage });
    const onClose = vi.fn();

    render(<RowMenu pageId={PAGE_ID} onClose={onClose} />);
    const duplicate = screen.getByRole("menuitem", { name: /^Duplicate/ });
    fireEvent.click(duplicate);

    await waitFor(() => expect((duplicate as HTMLButtonElement).disabled).toBe(true));
    expect(duplicate.getAttribute("aria-busy")).toBe("true");
    expect(duplicate.textContent).toContain("Duplicate…");
    fireEvent.click(duplicate);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(duplicatePage).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    releaseDuplicate();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("moves comment-panel focus out of the inert background and traps root Shift+Tab", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open comments</button>
          {open ? <CommentsPanel pageId={PAGE_ID} onClose={() => setOpen(false)} /> : null}
        </>
      );
    }

    const result = render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open comments" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Comments" });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(result.container.inert).toBe(true);

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(dialog);

    fireEvent.click(within(dialog).getByRole("button", { name: "Close comments" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Comments" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("page heading contract", () => {
  it.each([
    ["", "Untitled"],
    ["Authored title", "Authored title"],
  ])("exposes an h1 name for %j while retaining the title textbox", (title, headingName) => {
    seedPages([makePage({ id: PAGE_ID, title })]);
    render(<PageHeader pageId={PAGE_ID} />);

    expect(screen.getByRole("heading", { level: 1, name: headingName })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Page title" })).toBeTruthy();
  });
});
