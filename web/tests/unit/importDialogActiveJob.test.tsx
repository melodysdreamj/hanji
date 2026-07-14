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
    applyNotionImportJobRemote: vi.fn(),
    beginNotionOAuthConnectionRemote: vi.fn(() => new Promise(() => {})),
    cancelNotionImportJobRemote: vi.fn(async () => ({
      job: {
        id: "job-live-1",
        status: "cancelled",
        connectionKind: "manual_token",
        counts: {},
        rootNotionPageIds: [],
        rootNotionDataSourceIds: [],
        progress: { percent: 15, steps: [] },
      },
    })),
    createNotionImportConnectionRemote: vi.fn(async () => ({
      connection: {
        id: "connection-auto",
        name: "Stored automatically",
        connectionKind: "internal_integration",
        status: "active",
      },
    })),
    fetchRuntimeConfigRemote: vi.fn(async () => ({
      allowAnonymousBootstrap: false,
      oauthProviders: [],
      notionOAuthConfigured: true,
      legal: actual.DEFAULT_LEGAL_LINKS,
    })),
    listNotionImportJobsRemote: vi.fn(async () => ({ jobs: [] })),
    listNotionImportConnectionsRemote: vi.fn(async () => ({
      connections: [{
        id: "connection-1",
        name: "Stored connection",
        connectionKind: "internal_integration",
        status: "active",
      }],
      connectionStorageAvailable: true,
    })),
    repairNotionImportPageIndexesRemote: vi.fn(async () => ({
      unwrapped: 0,
      trashed: 0,
    })),
    discoverNotionImportJobRemote: vi.fn(async () => ({
      job: {
        id: "job-live-1",
        status: "ready",
        connectionId: "connection-1",
        connectionKind: "internal_integration",
        counts: {},
        rootNotionPageIds: [],
        rootNotionDataSourceIds: [],
        progress: { hasMore: false, percent: 100, steps: [] },
      },
      itemCount: 0,
    })),
    getNotionImportJobRemote: vi.fn(async () => ({
      job: {
        id: "job-live-1",
        status: "ready",
        connectionId: "connection-1",
        connectionKind: "internal_integration",
        counts: {},
        rootNotionPageIds: [],
        rootNotionDataSourceIds: [],
        progress: { hasMore: false, percent: 100, steps: [] },
      },
      items: [],
    })),
  };
});

import { ImportDialog } from "@/components/ImportDialog";
import {
  DEFAULT_LEGAL_LINKS,
  applyNotionImportJobRemote,
  beginNotionOAuthConnectionRemote,
  cancelNotionImportJobRemote,
  createNotionImportConnectionRemote,
  discoverNotionImportJobRemote,
  fetchRuntimeConfigRemote,
  listNotionImportConnectionsRemote,
  listNotionImportJobsRemote,
  repairNotionImportPageIndexesRemote,
} from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import { resetStore, seedUser } from "./components/storeTestUtils";

const listJobsMock = vi.mocked(listNotionImportJobsRemote);
const listConnectionsMock = vi.mocked(listNotionImportConnectionsRemote);
const applyJobMock = vi.mocked(applyNotionImportJobRemote);
const createConnectionMock = vi.mocked(createNotionImportConnectionRemote);

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
  progress: { percent: 30, step: "discover", steps: [], searchComplete: true },
  connectionId: "connection-1",
  connectionKind: "internal_integration",
  rootNotionPageIds: [],
  rootNotionDataSourceIds: [],
};

const manualTokenLiveJob = {
  ...liveJob,
  connectionId: undefined,
  connectionKind: "manual_token",
  progress: { percent: 15, step: "discover", steps: [] },
};

const interruptedApplyJob = {
  ...liveJob,
  status: "ready",
  phase: "apply_pages",
  progress: {
    percent: 72,
    currentStep: "apply",
    currentStatus: "running",
    applyCursor: { phase: "apply_pages", pageIndex: 20, totalPages: 385 },
    steps: [],
  },
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
  listConnectionsMock.mockResolvedValue({
    connections: [{
      id: "connection-1",
      name: "Stored connection",
      connectionKind: "internal_integration",
      status: "active",
    }],
    connectionStorageAvailable: true,
  } as never);
  applyJobMock.mockReset();
  applyJobMock.mockResolvedValue({
    job: {
      ...liveJob,
      status: "completed",
      phase: "applied",
      progress: {
        hasMore: false,
        percent: 100,
        currentStep: "apply",
        currentStatus: "completed",
        steps: [],
      },
    },
    applied: { pages: 1 },
    mappings: [],
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImportDialog default source", () => {
  it("does not probe protected Notion import state while the persistent dialog is closed", async () => {
    render(<ImportDialog open={false} onClose={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listJobsMock).not.toHaveBeenCalled();
    expect(listConnectionsMock).not.toHaveBeenCalled();
    expect(vi.mocked(repairNotionImportPageIndexesRemote)).not.toHaveBeenCalled();
  });

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

  it("applies the requested source when the persistent dialog reopens", async () => {
    const onClose = vi.fn();
    const view = render(<ImportDialog open={false} onClose={onClose} />);

    view.rerender(<ImportDialog open initialTab="hanji" onClose={onClose} />);

    const hanjiSource = await screen.findByRole("button", { name: "Hanji" });
    await waitFor(() => expect(hanjiSource.getAttribute("data-active")).toBe("true"));
    expect(screen.getByText("Import from Hanji")).toBeTruthy();
  });

  it("shows the OAuth start action only from the backend capability and begins with the exact SPA callback", async () => {
    render(<ImportDialog onClose={vi.fn()} />);

    const connect = await screen.findByRole("button", { name: "Connect with Notion" });
    fireEvent.click(connect);

    await waitFor(() => {
      expect(vi.mocked(beginNotionOAuthConnectionRemote)).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        name: undefined,
        redirectUri: `${window.location.origin}/?notion_import_oauth=1`,
      });
    });
  });

  it("keeps the token-first flow free of an OAuth action when the backend capability is off", async () => {
    vi.mocked(fetchRuntimeConfigRemote).mockResolvedValueOnce({
      allowAnonymousBootstrap: false,
      oauthProviders: [],
      notionOAuthConfigured: false,
      legal: DEFAULT_LEGAL_LINKS,
    });
    render(<ImportDialog onClose={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Connect with Notion" })).toBeNull();
    expect(screen.getByPlaceholderText("ntn_...")).toBeTruthy();
  });

  it("stores a pasted token on the server before advancing to import scope", async () => {
    listConnectionsMock.mockResolvedValue({
      connections: [],
      connectionStorageAvailable: true,
    } as never);
    render(<ImportDialog onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Notion API token"), {
      target: { value: "ntn_store-on-server" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(createConnectionMock).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        name: undefined,
        connectionKind: "internal_integration",
        notionToken: "ntn_store-on-server",
      });
    });
    expect(await screen.findByRole("button", { name: "Start discovery" })).toBeTruthy();
    expect(screen.queryByDisplayValue("ntn_store-on-server")).toBeNull();
  });

  it("keeps request-only token behavior only when the server reports storage unavailable", async () => {
    listConnectionsMock.mockResolvedValue({
      connections: [],
      connectionStorageAvailable: false,
    } as never);
    render(<ImportDialog onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Notion API token"), {
      target: { value: "ntn_local-fallback" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("button", { name: "Start discovery" })).toBeTruthy();
    expect(createConnectionMock).not.toHaveBeenCalled();
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
    // list was removed, and the wizard must stay on step 1 (Connect) instead of
    // auto-filling the run panel — so neither the live-activity feed nor the
    // Apply action appears.
    expect(screen.queryByLabelText("Live activity")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();
  });

  it("resumes a still-running job into the run panel", async () => {
    listJobsMock.mockResolvedValue({ jobs: [liveJob] } as never);
    await openNotionSource();

    // A live import genuinely in progress auto-advances the wizard to the
    // discover step and surfaces the installer-style run panel.
    expect(await screen.findByLabelText("Live activity")).toBeTruthy();
    await waitFor(() => {
      expect(vi.mocked(discoverNotionImportJobRemote)).toHaveBeenCalledWith({
        jobId: "job-live-1",
        workspaceId: "ws-1",
        notionToken: undefined,
        connectionId: "connection-1",
        continueFromCursor: true,
        incremental: true,
      });
    });
  });

  it("continues from completed discovery into apply without another click", async () => {
    let finishDiscovery!: (value: Awaited<ReturnType<typeof discoverNotionImportJobRemote>>) => void;
    vi.mocked(discoverNotionImportJobRemote).mockImplementationOnce(
      () => new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    );
    listJobsMock.mockResolvedValue({ jobs: [liveJob] } as never);
    await openNotionSource();

    await waitFor(() => expect(vi.mocked(discoverNotionImportJobRemote)).toHaveBeenCalledTimes(1));
    const discovered = {
      ...liveJob,
      status: "ready",
      phase: "discovered",
      progress: {
        hasMore: false,
        percent: 100,
        currentStep: "discover",
        currentStatus: "completed",
        steps: [],
      },
    };
    listJobsMock.mockResolvedValue({ jobs: [discovered] } as never);

    await act(async () => {
      finishDiscovery({ job: discovered, itemCount: 1 } as never);
    });

    await waitFor(() => expect(applyJobMock).toHaveBeenCalledTimes(1));
    expect(applyJobMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      jobId: "job-live-1",
      connectionId: "connection-1",
    }));
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();
  });

  it("keeps one runner alive while the modal is hidden and clears the activity when it settles", async () => {
    let finishDiscovery!: (value: Awaited<ReturnType<typeof discoverNotionImportJobRemote>>) => void;
    vi.mocked(discoverNotionImportJobRemote).mockImplementationOnce(
      () => new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    );
    listJobsMock.mockResolvedValue({ jobs: [liveJob] } as never);
    const onActivityChange = vi.fn();
    const view = render(
      <ImportDialog open onClose={vi.fn()} onActivityChange={onActivityChange} />,
    );

    await waitFor(() => expect(vi.mocked(discoverNotionImportJobRemote)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onActivityChange).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-live-1",
      mode: "discover",
      percent: 30,
    })));
    expect(screen.getByText(/This import is running in this browser tab/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(screen.queryByText(/This import is running in this browser tab/)).toBeNull();
    view.rerender(
      <ImportDialog open={false} onClose={vi.fn()} onActivityChange={onActivityChange} />,
    );
    expect(screen.queryByRole("dialog", { name: "Import" })).toBeNull();
    const closingWhileLive = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(closingWhileLive);
    expect(closingWhileLive.defaultPrevented).toBe(true);

    const completedJob = {
      ...liveJob,
      status: "ready",
      progress: { hasMore: false, percent: 50, steps: [] },
    };
    listJobsMock.mockResolvedValue({ jobs: [completedJob] } as never);
    await act(async () => {
      finishDiscovery({ job: completedJob, itemCount: 0 } as never);
    });

    await waitFor(() => expect(onActivityChange).toHaveBeenLastCalledWith(null));
    expect(vi.mocked(discoverNotionImportJobRemote)).toHaveBeenCalledTimes(1);
    const closingAfterSettle = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(closingAfterSettle);
    expect(closingAfterSettle.defaultPrevented).toBe(false);

    view.rerender(
      <ImportDialog open onClose={vi.fn()} onActivityChange={onActivityChange} />,
    );
    expect(await screen.findByRole("dialog", { name: "Import" })).toBeTruthy();
    expect(vi.mocked(discoverNotionImportJobRemote)).toHaveBeenCalledTimes(1);
  });

  it("asks for a one-time token after reload instead of pretending the orphaned job is still running", async () => {
    let finishDiscovery!: (value: Awaited<ReturnType<typeof discoverNotionImportJobRemote>>) => void;
    vi.mocked(discoverNotionImportJobRemote).mockImplementationOnce(
      () => new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    );
    listJobsMock.mockResolvedValue({ jobs: [manualTokenLiveJob] } as never);
    listConnectionsMock.mockResolvedValue({
      connections: [],
      connectionStorageAvailable: true,
    } as never);
    await openNotionSource();

    await waitFor(() => expect(listJobsMock).toHaveBeenCalled());
    expect(vi.mocked(discoverNotionImportJobRemote)).not.toHaveBeenCalled();
    const tokenInput = await screen.findByLabelText("Notion API token");
    expect(tokenInput).toBeTruthy();

    fireEvent.change(tokenInput, { target: { value: "ntn_resume-token" } });
    fireEvent.click(await screen.findByRole("button", { name: "Resume discovery" }));

    // Manual resume keeps the same live job id/status, so it cannot rely on a
    // later active-job transition to leave Connect. Show progress immediately
    // while the first bounded discovery request is still pending.
    expect(await screen.findByLabelText("Live activity")).toBeTruthy();

    await waitFor(() => {
      expect(createConnectionMock).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "ws-1",
        notionToken: "ntn_resume-token",
      }));
      expect(vi.mocked(discoverNotionImportJobRemote)).toHaveBeenCalledWith({
        jobId: "job-live-1",
        workspaceId: "ws-1",
        notionToken: undefined,
        connectionId: "connection-auto",
        continueFromCursor: false,
        incremental: true,
      });
    });
    await act(async () => {
      finishDiscovery({
        job: {
          ...manualTokenLiveJob,
          status: "ready",
          progress: { hasMore: false, percent: 100, steps: [] },
        },
        itemCount: 0,
      } as never);
    });
  });

  it("lets a manual-token job be cancelled before the token is re-entered", async () => {
    listJobsMock.mockResolvedValue({ jobs: [manualTokenLiveJob] } as never);
    listConnectionsMock.mockResolvedValue({
      connections: [],
      connectionStorageAvailable: true,
    } as never);
    await openNotionSource();

    const cancel = await screen.findByRole("button", { name: "Cancel import" });
    listJobsMock.mockResolvedValue({
      jobs: [{ ...manualTokenLiveJob, status: "cancelled" }],
    } as never);
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(vi.mocked(cancelNotionImportJobRemote)).toHaveBeenCalledWith("job-live-1", "ws-1");
    });
  });

  it("resumes a persisted apply and follows partial responses until completion", async () => {
    const completed = {
      ...interruptedApplyJob,
      status: "completed",
      phase: "applied",
      progress: {
        percent: 100,
        currentStep: "apply",
        currentStatus: "completed",
        steps: [],
      },
    };
    listJobsMock.mockResolvedValue({ jobs: [interruptedApplyJob] } as never);
    applyJobMock
      .mockResolvedValueOnce({
        job: {
          ...interruptedApplyJob,
          phase: "apply_database_containers",
        },
        applied: { databases: 25 },
        mappings: [],
        partial: true,
      } as never)
      .mockResolvedValueOnce({
        job: completed,
        applied: { pages: 385, databases: 259 },
        mappings: [],
      } as never);

    await openNotionSource();

    await waitFor(() => expect(applyJobMock).toHaveBeenCalledTimes(2));
    expect(applyJobMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId: "ws-1",
      jobId: "job-live-1",
      connectionId: "connection-1",
      applyDatabaseBatchSize: 25,
      applyPageBatchSize: 20,
    }));
    expect(applyJobMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      jobId: "job-live-1",
      applyDatabaseBatchSize: 25,
      applyPageBatchSize: 20,
    }));
  });

  it("labels a manual-token apply retry as retry instead of discovery", async () => {
    const manualInterruptedApplyJob = {
      ...interruptedApplyJob,
      connectionId: undefined,
      connectionKind: "manual_token",
    };
    const completed = {
      ...manualInterruptedApplyJob,
      status: "completed",
      phase: "applied",
      progress: {
        percent: 100,
        currentStep: "apply",
        currentStatus: "completed",
        steps: [],
      },
    };
    listJobsMock.mockResolvedValue({ jobs: [manualInterruptedApplyJob] } as never);
    listConnectionsMock.mockResolvedValue({
      connections: [],
      connectionStorageAvailable: true,
    } as never);
    applyJobMock.mockResolvedValue({
      job: completed,
      applied: { pages: 385, databases: 259 },
      mappings: [],
    } as never);

    await openNotionSource();

    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.change(await screen.findByLabelText("Notion API token"), {
      target: { value: "ntn_resume-token" },
    });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(createConnectionMock).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "ws-1",
        notionToken: "ntn_resume-token",
      }));
      expect(applyJobMock).toHaveBeenCalledWith(expect.objectContaining({
        jobId: "job-live-1",
        notionToken: undefined,
        connectionId: "connection-auto",
      }));
    });
  });
});
