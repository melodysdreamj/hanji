// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedState = vi.hoisted(() => ({
  getSharedPageRemote: vi.fn(),
  applySharedPageSnapshot: vi.fn(),
}));

vi.mock("@/lib/edgebase", () => ({
  getSharedPageRemote: sharedState.getSharedPageRemote,
}));

vi.mock("@/lib/store", () => ({
  useStore: (selector: (state: { applySharedPageSnapshot: typeof sharedState.applySharedPageSnapshot }) => unknown) =>
    selector({ applySharedPageSnapshot: sharedState.applySharedPageSnapshot }),
}));

vi.mock("@/components/TopBar", () => ({
  TopBar: ({ title }: { title: string }) => <div data-testid="topbar">{title}</div>,
}));

vi.mock("@/components/PageView", () => ({
  PageView: ({ pageId }: { pageId: string }) => <div data-testid="page-view">{pageId}</div>,
}));

import { SharedPageView } from "@/components/SharedPageView";

beforeEach(() => {
  window.history.replaceState(null, "", "/share/public-token");
  sharedState.getSharedPageRemote.mockReset();
  sharedState.applySharedPageSnapshot.mockReset();
});

afterEach(cleanup);

describe("SharedPageView failure recovery", () => {
  it("never exposes raw backend details and lets the reader retry", async () => {
    sharedState.getSharedPageRemote
      .mockRejectedValueOnce(new Error("database shard public_pages_internal failed"))
      .mockRejectedValueOnce(Object.assign(new Error("hidden token lookup"), { code: 404 }));

    render(<SharedPageView token="public-token" />);

    expect(await screen.findByText(/could not open this shared page right now/i)).toBeTruthy();
    expect(screen.queryByText(/database shard|public_pages_internal/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(/may have expired, been unpublished, or been copied incorrectly/i)).toBeTruthy();
    expect(screen.queryByText(/hidden token lookup/i)).toBeNull();
    expect(sharedState.getSharedPageRemote).toHaveBeenCalledTimes(2);
  });
});
