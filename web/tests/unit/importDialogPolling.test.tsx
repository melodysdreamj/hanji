// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edgebase")>()),
  getNotionImportJobRemote: vi.fn(),
  listNotionImportJobsRemote: vi.fn(),
  listNotionImportConnectionsRemote: vi.fn(async () => ({
    connections: [],
    connectionStorageAvailable: true,
  })),
  repairNotionImportPageIndexesRemote: vi.fn(async () => ({ repaired: 0 })),
}));

import { ImportDialog } from "@/components/ImportDialog";
import {
  getNotionImportJobRemote,
  listNotionImportConnectionsRemote,
  listNotionImportJobsRemote,
} from "@/lib/edgebase";
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
  it("polls only the active job every three seconds without overlapping", async () => {
    const slow = deferred<{ job: typeof liveJob }>();
    vi.mocked(listNotionImportJobsRemote).mockResolvedValue({ jobs: [liveJob] } as never);
    vi.mocked(getNotionImportJobRemote)
      .mockImplementationOnce(() => slow.promise as never)
      .mockResolvedValue({ job: liveJob } as never);

    render(<ImportDialog onClose={vi.fn()} />);
    await flush();
    expect(vi.mocked(listNotionImportJobsRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listNotionImportConnectionsRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getNotionImportJobRemote)).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_900);
    });
    expect(vi.mocked(listNotionImportJobsRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getNotionImportJobRemote)).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(vi.mocked(getNotionImportJobRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getNotionImportJobRemote)).toHaveBeenCalledWith("live", "ws-1");
    expect(vi.mocked(listNotionImportJobsRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listNotionImportConnectionsRemote)).toHaveBeenCalledTimes(1);

    // The active-job read is unresolved. Advancing through many nominal poll
    // intervals must not start more reads on top of it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(vi.mocked(getNotionImportJobRemote)).toHaveBeenCalledTimes(1);

    slow.resolve({ job: liveJob });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(vi.mocked(getNotionImportJobRemote)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listNotionImportJobsRemote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listNotionImportConnectionsRemote)).toHaveBeenCalledTimes(1);
  });
});
