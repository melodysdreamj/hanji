// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edgebase")>()),
  bootstrapWorkspace: vi.fn(async () => {
    throw new Error("Unexpected bootstrap in toast test.");
  }),
}));

import { useStore } from "@/lib/store";
import { resetStore } from "./components/storeTestUtils";

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("action toast lifetime", () => {
  it("keeps recovery/update actions until explicitly dismissed", async () => {
    const id = useStore.getState().notify("Resolve conflict", "error", {
      label: "Keep mine",
      onClick: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(useStore.getState().toasts.map((toast) => toast.id)).toContain(id);

    useStore.getState().dismissToast(id);
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it("still auto-dismisses informational toasts", async () => {
    useStore.getState().notify("Saved", "success");
    await vi.advanceTimersByTimeAsync(2_700);
    expect(useStore.getState().toasts).toHaveLength(0);
  });
});
