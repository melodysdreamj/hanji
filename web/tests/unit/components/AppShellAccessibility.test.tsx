// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edgebase")>()),
  currentUserEmail: vi.fn(() => ""),
  listMyInvitationsRemote: vi.fn(async () => []),
}));

vi.mock("@/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/SyncStatusBadge", () => ({ default: () => null }));
vi.mock("@/components/ToastStack", () => ({ ToastStack: () => null }));

import { AppShell } from "@/components/AppShell";
import { useRouter } from "@/lib/router";
import { useStore } from "@/lib/store";
import { resetStore } from "./storeTestUtils";

function RouteControl() {
  const router = useRouter();
  return (
    <button type="button" onClick={() => router.push("/trash")}>
      Go to trash
    </button>
  );
}

beforeEach(() => {
  resetStore();
  window.history.replaceState(null, "", "/");
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
  useStore.setState({
    ready: true,
    userId: null,
    bootstrap: vi.fn(async () => undefined),
  });
});

afterEach(cleanup);

describe("AppShell accessibility navigation", () => {
  it("keeps an already-open inbox through the initial mount, then closes it on navigation", async () => {
    useStore.setState({ updatesOpen: true });
    render(
      <AppShell>
        <RouteControl />
      </AppShell>
    );

    await waitFor(() => expect(useStore.getState().updatesOpen).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Go to trash" }));

    await waitFor(() => expect(useStore.getState().updatesOpen).toBe(false));
  });

  it("links the skip control to a focusable main and focuses/announces route changes", async () => {
    render(
      <AppShell>
        <RouteControl />
      </AppShell>
    );

    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main", { name: "Home" });
    expect(skipLink.getAttribute("href")).toBe("#app-main-content");
    expect(main.id).toBe("app-main-content");
    expect(main.tabIndex).toBe(-1);

    fireEvent.click(screen.getByRole("button", { name: "Go to trash" }));

    await waitFor(() => expect(document.activeElement).toBe(main));
    expect(screen.getByRole("main", { name: "Trash" })).toBe(main);
    expect(screen.getByText("Navigated to Trash").getAttribute("aria-live")).toBe("polite");
  });
});
