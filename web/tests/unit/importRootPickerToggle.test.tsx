// @vitest-environment jsdom
//
// Regression guard for the Notion import root picker.
//
// Toggling a scanned candidate must not crash. The checkbox `onChange` reads
// `event.currentTarget.checked`; React nulls `currentTarget` after the handler
// returns, so if that read happens inside the deferred `setState` updater it
// throws `Cannot read properties of null (reading 'checked')` during render.
// Because ImportDialog is mounted outside any ErrorBoundary (Sidebar/AppShell),
// that render crash unmounts the whole app — a blank white screen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    listNotionImportJobsRemote: vi.fn(async () => ({ jobs: [] })),
    listNotionImportConnectionsRemote: vi.fn(async () => ({
      connections: [],
      connectionStorageAvailable: true,
    })),
    createNotionImportConnectionRemote: vi.fn(async () => ({
      connection: {
        id: "connection-root-picker",
        name: "Root picker connection",
        connectionKind: "internal_integration",
        status: "active",
      },
    })),
    listNotionImportRootsRemote: vi.fn(async () => ({
      notionWorkspace: { id: "nw", name: "sample-workspace" },
      items: [
        {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
          notionObject: "page",
          title: "안녕",
          parentType: "workspace",
          parentNotionId: null,
        },
        {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
          notionObject: "page",
          title: "경영관제 센터",
          parentType: "workspace",
          parentNotionId: null,
        },
      ],
      roots: [],
      scanned: 2,
      searchPagesFetched: 1,
      hasMore: false,
      nextCursor: null,
    })),
  };
});

import { ImportDialog } from "@/components/ImportDialog";
import { useStore } from "@/lib/store";
import { resetStore, seedUser } from "./components/storeTestUtils";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openRootPicker() {
  render(<ImportDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Notion" }));
  await flush();
  fireEvent.change(screen.getByPlaceholderText("ntn_..."), {
    target: { value: "ntn_testtoken" },
  });
  await flush();
  // The scope options live on wizard step 2 now.
  fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
  await flush();
  fireEvent.click(screen.getByLabelText(/Specific pages/i));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /Scan accessible roots/i }));
  await flush();
  await flush();
  return screen.getByRole("group", { name: /Accessible top-level items/i });
}

beforeEach(() => {
  resetStore();
  seedUser();
  useStore.setState({ workspace: { id: "ws-1", name: "My Workspace" } as never });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ImportDialog Notion root picker", () => {
  it("toggling a scanned candidate does not throw or unmount the dialog", async () => {
    const list = await openRootPicker();
    const checkboxes = within(list).getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.length).toBeGreaterThan(0);

    // The scan auto-selects every candidate; the first click unchecks one.
    expect(() => fireEvent.click(checkboxes[0])).not.toThrow();
    await flush();

    // Dialog still mounted (no crash → no blank screen) and the toggle took.
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(checkboxes[0].checked).toBe(false);

    // Re-checking works too.
    expect(() => fireEvent.click(checkboxes[0])).not.toThrow();
    await flush();
    expect(checkboxes[0].checked).toBe(true);
  });
});
