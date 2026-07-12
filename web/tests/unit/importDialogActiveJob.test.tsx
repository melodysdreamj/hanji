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
    beginNotionOAuthConnectionRemote: vi.fn(() => new Promise(() => {})),
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
  beginNotionOAuthConnectionRemote,
  discoverNotionImportJobRemote,
  fetchRuntimeConfigRemote,
  listNotionImportJobsRemote,
} from "@/lib/edgebase";
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
  connectionId: "connection-1",
  connectionKind: "internal_integration",
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
});
