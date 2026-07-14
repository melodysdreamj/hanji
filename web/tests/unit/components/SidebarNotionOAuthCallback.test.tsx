// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ImportDialog", () => ({
  ImportDialog: ({
    initialTab,
    onActivityChange,
    open,
  }: {
    initialTab?: string;
    onActivityChange?: (activity: { jobId: string; mode: "discover"; percent: number }) => void;
    open?: boolean;
  }) => (
    <div data-testid="oauth-import-dialog" data-open={open ? "true" : "false"}>
      <span data-testid="oauth-import-tab">{initialTab ?? "default"}</span>
      <button
        type="button"
        data-testid="emit-import-activity"
        onClick={() => onActivityChange?.({ jobId: "job-1", mode: "discover", percent: 42 })}
      >
        emit activity
      </button>
    </div>
  ),
}));

vi.mock("@/lib/edgebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edgebase")>()),
  claimNotionImportOnboardingRemote: vi.fn(async () => ({ show: false })),
  fetchSponsorsRemote: vi.fn(async () => ({ sponsors: [], disabled: true })),
  listNotificationsRemote: vi.fn(async () => []),
  suppressNotionImportOnboardingRemote: vi.fn(async () => undefined),
}));

import { notionOAuthCallbackPending, Sidebar } from "@/components/Sidebar";
import { claimNotionImportOnboardingRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import { resetStore, seedUser } from "./storeTestUtils";

beforeEach(() => {
  vi.mocked(claimNotionImportOnboardingRemote).mockReset();
  vi.mocked(claimNotionImportOnboardingRemote).mockResolvedValue({ show: false });
  window.history.replaceState(null, "", "/?notion_import_oauth=1&code=synthetic-code&state=synthetic-state");
  resetStore();
  seedUser();
  useStore.setState({
    workspace: { id: "ws-1", name: "Synthetic workspace" } as never,
    workspaces: [{ id: "ws-1", name: "Synthetic workspace" }] as never,
  });
});

afterEach(cleanup);

describe("Sidebar Notion OAuth callback handoff", () => {
  it("recognizes only the explicit callback marker", () => {
    expect(notionOAuthCallbackPending(new URLSearchParams("notion_import_oauth=1"))).toBe(true);
    expect(notionOAuthCallbackPending(new URLSearchParams("notion_import_oauth=0"))).toBe(false);
  });

  it("mounts the import dialog on its Notion tab on the callback's first render", async () => {
    render(
      <Sidebar
        collapsed={false}
        onToggle={vi.fn()}
        mobile={false}
        open
      />,
    );

    expect((await screen.findByTestId("oauth-import-tab")).textContent).toBe("notion");
  });

  it("keeps the import controller mounted and reopens progress from the sidebar", async () => {
    window.history.replaceState(null, "", "/");
    render(
      <Sidebar
        collapsed={false}
        onToggle={vi.fn()}
        mobile={false}
        open
      />,
    );

    const controller = await screen.findByTestId("oauth-import-dialog");
    expect(controller.getAttribute("data-open")).toBe("false");
    fireEvent.click(screen.getByTestId("emit-import-activity"));

    const progress = screen.getByRole("button", {
      name: "Notion import in progress, 42%",
    });
    expect(progress.textContent).toContain("Importing");
    expect(progress.textContent).toContain("42%");

    fireEvent.click(progress);
    expect(controller.getAttribute("data-open")).toBe("true");
  });

  it("opens the Notion import tab from the server-claimed first-admin prompt", async () => {
    window.history.replaceState(null, "", "/");
    vi.mocked(claimNotionImportOnboardingRemote).mockResolvedValueOnce({ show: true });
    useStore.setState({
      isInstanceAdmin: true,
      workspace: { id: "ws-1", name: "Synthetic workspace", ownerId: "user-test" } as never,
      currentMember: {
        id: "member-1",
        workspaceId: "ws-1",
        userId: "user-test",
        role: "owner",
      } as never,
    });
    render(
      <Sidebar
        collapsed={false}
        onToggle={vi.fn()}
        mobile={false}
        open
      />,
    );

    expect(await screen.findByRole("dialog", {
      name: "Bring your Notion workspace to Hanji?",
    })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import from Notion" }));

    await waitFor(() => {
      expect(screen.getByTestId("oauth-import-dialog").getAttribute("data-open")).toBe("true");
      expect(screen.getByTestId("oauth-import-tab").textContent).toBe("notion");
    });
  });
});
