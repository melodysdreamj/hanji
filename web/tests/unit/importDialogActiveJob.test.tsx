// @vitest-environment jsdom
//
// Guards which job the Notion import dialog surfaces in the step-3 "Progress"
// panel when reopened. A finished/"ready" job from a previous import must NOT
// auto-fill the panel over a fresh scope selection — and since the recent-jobs
// history list was removed, such a job no longer surfaces anywhere on reopen.
// A job still genuinely running in the background SHOULD resume into the panel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    listNotionImportJobsRemote: vi.fn(async () => ({ jobs: [] })),
    listNotionImportConnectionsRemote: vi.fn(async () => ({
      connections: [],
      connectionStorageAvailable: true,
    })),
  };
});

import { ImportDialog } from "@/components/ImportDialog";
import { listNotionImportJobsRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import { resetStore, seedUser } from "./components/storeTestUtils";

const listJobsMock = vi.mocked(listNotionImportJobsRemote);

const readyJob = {
  id: "job-ready-1",
  status: "ready",
  notionWorkspaceName: "Old Workspace",
  counts: { page: 10, database: 1 },
  progress: { percent: 100, discovered: 11, steps: [] },
  rootNotionPageIds: [],
  rootNotionDataSourceIds: [],
  report: {},
};

const liveJob = {
  id: "job-live-1",
  status: "discovering",
  notionWorkspaceName: "Live Workspace",
  counts: {},
  progress: { percent: 30, step: "discover", steps: [] },
  rootNotionPageIds: [],
  rootNotionDataSourceIds: [],
};

async function openNotionSource() {
  render(<ImportDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Notion" }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetStore();
  seedUser();
  useStore.setState({ workspace: { id: "ws-1", name: "My Workspace" } as never });
  listJobsMock.mockResolvedValue({ jobs: [] } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImportDialog default source", () => {
  it("opens on the Notion tab, not the file tab", async () => {
    render(<ImportDialog onClose={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Notion tab content is shown immediately, without clicking any tab.
    expect(screen.getByPlaceholderText("ntn_...")).toBeTruthy();
    // The file (Markdown/CSV) dropzone is not the initial view.
    expect(screen.queryByText("Choose a file")).toBeNull();
  });
});

describe("ImportDialog active-job selection on reopen", () => {
  it("does not surface a previous ready job on reopen", async () => {
    listJobsMock.mockResolvedValue({ jobs: [readyJob] } as never);
    await openNotionSource();

    // Confirm the async job load actually completed before asserting absence.
    await waitFor(() => expect(listJobsMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    // A prior "ready" job no longer surfaces anywhere: the recent-jobs history
    // list was removed, and the step-3 "Progress" panel must not auto-fill on
    // reopen — so neither the panel nor its Apply action appears.
    expect(screen.queryByText("Progress")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("resumes a still-running job into the progress panel", async () => {
    listJobsMock.mockResolvedValue({ jobs: [liveJob] } as never);
    await openNotionSource();

    // A live import genuinely in progress should surface in the panel.
    expect(await screen.findByText("Progress")).toBeTruthy();
  });
});
