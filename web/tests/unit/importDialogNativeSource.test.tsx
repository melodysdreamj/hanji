// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edgebase")>()),
  listNotionImportJobsRemote: vi.fn(async () => ({ jobs: [] })),
  listNotionImportConnectionsRemote: vi.fn(async () => ({
    connections: [],
    connectionStorageAvailable: true,
  })),
  repairNotionImportPageIndexesRemote: vi.fn(async () => ({ repaired: 0 })),
}));

import { ImportDialog } from "@/components/ImportDialog";
import { useStore } from "@/lib/store";
import { resetStore, seedUser } from "./components/storeTestUtils";

const exportPayload = {
  document: {
    format: "hanji.export",
    formatVersion: 1,
    counts: { pages: 1 },
    entities: { pages: [{ id: "p1" }] },
  },
};

beforeEach(() => {
  resetStore();
  seedUser();
  useStore.setState({ workspace: { id: "ws-1", name: "Workspace" } as never });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ImportDialog native source invalidation", () => {
  it("aborts and discards a preview when live source fields change", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        call += 1;
        if (call === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true }
            );
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => exportPayload,
        } as Response);
      })
    );

    render(<ImportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Hanji" }));
    fireEvent.click(screen.getByRole("radio", { name: /From a live instance/i }));

    const url = screen.getByLabelText("Remote Hanji URL");
    const workspace = screen.getByLabelText("Workspace id");
    fireEvent.change(url, { target: { value: "https://one.test" } });
    fireEvent.change(workspace, { target: { value: "source-ws" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch export" }));
    expect(screen.getByRole("button", { name: "Fetching..." })).toBeTruthy();

    // Changing a source field aborts request A and clears anything it could
    // later return. It also releases the busy state for request B.
    fireEvent.change(workspace, { target: { value: "source-ws-2" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Fetch export" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Fetch export" }));
    expect(await screen.findByRole("button", { name: "Import" })).toBeTruthy();

    act(() => {
      useStore.setState({ workspace: { id: "ws-2", name: "Other workspace" } as never });
    });
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Fetch export" }));
    expect(await screen.findByRole("button", { name: "Import" })).toBeTruthy();

    // The preview belongs to the exact URL/workspace/token fingerprint.
    fireEvent.change(url, { target: { value: "https://two.test" } });
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  });
});
