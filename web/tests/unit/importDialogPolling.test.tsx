// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edgebase")>()),
  listNotionImportJobsRemote: vi.fn(),
  listNotionImportConnectionsRemote: vi.fn(async () => ({
    connections: [],
    connectionStorageAvailable: true,
  })),
  repairNotionImportPageIndexesRemote: vi.fn(async () => ({ repaired: 0 })),
}));

import { ImportDialog } from "@/components/ImportDialog";
import { listNotionImportJobsRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import { resetStore, seedUser } from "./components/storeTestUtils";

const liveJob = {
  id: "live",
  status: "discovering",
  counts: {},
  progress: { currentStatus: "running" },
  rootNotionPageIds: [],
  rootNotionDataSourceIds: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  seedUser();
  useStore.setState({ workspace: { id: "ws-1", name: "Workspace" } as never });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ImportDialog Notion polling", () => {
  it("waits for a slow poll before scheduling the next one", async () => {
    const slow = deferred<{ jobs: Array<typeof liveJob> }>();
    vi.mocked(listNotionImportJobsRemote)
      .mockResolvedValueOnce({ jobs: [liveJob] } as never)
      .mockImplementationOnce(() => slow.promise as never)
      .mockResolvedValue({ jobs: [liveJob] } as never);

    render(<ImportDialog onClose={vi.fn()} />);
    await flush();
    expect(vi.mocked(listNotionImportJobsRemote)).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(vi.mocked(listNotionImportJobsRemote)).toHaveBeenCalledTimes(2);

    // The second request is unresolved. Advancing through many nominal poll
    // intervals must not start requests 3..N on top of it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(vi.mocked(listNotionImportJobsRemote)).toHaveBeenCalledTimes(2);

    slow.resolve({ jobs: [liveJob] });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(vi.mocked(listNotionImportJobsRemote)).toHaveBeenCalledTimes(3);
  });
});
