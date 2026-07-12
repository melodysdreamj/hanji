// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ImportDialog", () => ({
  ImportDialog: ({ initialTab }: { initialTab?: string }) => (
    <div data-testid="oauth-import-dialog">{initialTab ?? "default"}</div>
  ),
}));

vi.mock("@/lib/edgebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edgebase")>()),
  fetchSponsorsRemote: vi.fn(async () => ({ sponsors: [], disabled: true })),
  listNotificationsRemote: vi.fn(async () => []),
}));

import { notionOAuthCallbackPending, Sidebar } from "@/components/Sidebar";
import { useStore } from "@/lib/store";
import { resetStore, seedUser } from "./storeTestUtils";

beforeEach(() => {
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

    expect((await screen.findByTestId("oauth-import-dialog")).textContent).toBe("notion");
  });
});
