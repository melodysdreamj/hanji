// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  cachedWorkspaceFileObjectUrl,
  createWorkspaceFileDownloadUrl,
  currentUserId,
  evictCachedWorkspaceFiles,
} = vi.hoisted(() => ({
  cachedWorkspaceFileObjectUrl: vi.fn(),
  createWorkspaceFileDownloadUrl: vi.fn(),
  currentUserId: vi.fn(() => "user-a"),
  evictCachedWorkspaceFiles: vi.fn(async () => undefined),
}));

vi.mock("@/lib/storage", () => ({
  createWorkspaceFileDownloadUrl,
  workspaceFileApiOrigin: () => "https://edgebase.example",
}));

vi.mock("@/lib/edgebase", () => ({ currentUserId }));

vi.mock("@/lib/offlineFiles", () => ({
  cachedWorkspaceFileObjectUrl,
  evictCachedWorkspaceFiles,
}));

import {
  clearSignedWorkspaceFileUrlCache,
  resolveWorkspaceFileUrl,
  signedWorkspaceFileUrl,
  storageKeyFromUrl,
  useWorkspaceFileUrl,
  workspaceFileCacheFallbackAllowed,
} from "@/lib/fileUrls";

beforeEach(() => {
  clearSignedWorkspaceFileUrlCache();
  cachedWorkspaceFileObjectUrl.mockReset();
  createWorkspaceFileDownloadUrl.mockReset();
  currentUserId.mockReset();
  currentUserId.mockReturnValue("user-a");
  evictCachedWorkspaceFiles.mockClear();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  vi.useRealTimers();
});

describe("signed workspace file URL cache", () => {
  it("shares a fresh signed URL and refreshes it before expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    createWorkspaceFileDownloadUrl
      .mockResolvedValueOnce({
        url: "https://hanji.example/file?token=one",
        expiresAt: "2026-07-11T00:30:00.000Z",
      })
      .mockResolvedValueOnce({
        url: "https://hanji.example/file?token=two",
        expiresAt: "2026-07-11T01:00:00.000Z",
      });

    await expect(signedWorkspaceFileUrl("workspaces/a/file")).resolves.toContain("token=one");
    await expect(signedWorkspaceFileUrl("workspaces/a/file")).resolves.toContain("token=one");
    expect(createWorkspaceFileDownloadUrl).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-07-11T00:29:30.000Z"));
    await expect(signedWorkspaceFileUrl("workspaces/a/file")).resolves.toContain("token=two");
    expect(createWorkspaceFileDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it("evicts a rejected request so the next render can retry", async () => {
    createWorkspaceFileDownloadUrl
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValueOnce({
        url: "https://hanji.example/file?token=recovered",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

    await expect(signedWorkspaceFileUrl("workspaces/a/file")).rejects.toThrow("429");
    await expect(signedWorkspaceFileUrl("workspaces/a/file")).resolves.toContain("recovered");
    expect(createWorkspaceFileDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it("never reuses one principal's bearer URL for another principal", async () => {
    createWorkspaceFileDownloadUrl
      .mockResolvedValueOnce({
        url: "https://hanji.example/file?token=user-a",
        expiresAt: "2099-01-01T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        url: "https://hanji.example/file?token=user-b",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

    await expect(signedWorkspaceFileUrl("workspaces/shared/key")).resolves.toContain("user-a");
    currentUserId.mockReturnValue("user-b");
    await expect(signedWorkspaceFileUrl("workspaces/shared/key")).resolves.toContain("user-b");

    expect(createWorkspaceFileDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it("rejects an in-flight bearer URL after the principal changes", async () => {
    let finishRequest!: (value: { url: string; expiresAt: string }) => void;
    createWorkspaceFileDownloadUrl.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishRequest = resolve;
      })
    );

    const pending = signedWorkspaceFileUrl("workspaces/shared/race");
    currentUserId.mockReturnValue("user-b");
    finishRequest({
      url: "https://hanji.example/file?token=user-a-in-flight",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await expect(pending).rejects.toMatchObject({
      code: "SIGNED_FILE_CONTEXT_CHANGED",
    });
  });

  it("rejects an in-flight bearer URL after cache clearing even for the same principal", async () => {
    let finishRequest!: (value: { url: string; expiresAt: string }) => void;
    createWorkspaceFileDownloadUrl.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishRequest = resolve;
      })
    );

    const pending = signedWorkspaceFileUrl("workspaces/shared/session-race");
    clearSignedWorkspaceFileUrlCache();
    finishRequest({
      url: "https://hanji.example/file?token=retired-session",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await expect(pending).rejects.toMatchObject({
      code: "SIGNED_FILE_CONTEXT_CHANGED",
    });
  });

  it("clears a mounted file URL and ignores its in-flight result when the session is cleared", async () => {
    let finishRequest!: (value: { url: string; expiresAt: string }) => void;
    createWorkspaceFileDownloadUrl.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishRequest = resolve;
      })
    );
    const key = "workspaces/shared/mounted-race.pdf";
    const { result } = renderHook(() =>
      useWorkspaceFileUrl(`/api/storage/files/${encodeURIComponent(key)}`)
    );
    await waitFor(() => expect(createWorkspaceFileDownloadUrl).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event("hanji:clear-signed-file-url-cache"));
    });
    finishRequest({
      url: "https://hanji.example/file?token=retired-mounted-session",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await waitFor(() => expect(result.current).toBe(""));
  });
});

describe("workspace storage URL recognition", () => {
  it("accepts only the app or configured EdgeBase origin", () => {
    const key = "workspaces/ws/files/a b.png";
    expect(storageKeyFromUrl(`/api/storage/files/${encodeURIComponent(key)}`)).toBe(key);
    expect(
      storageKeyFromUrl(`https://edgebase.example/api/storage/files/${encodeURIComponent(key)}`)
    ).toBe(key);
    expect(
      storageKeyFromUrl(`https://files.example/api/storage/files/${encodeURIComponent(key)}`)
    ).toBe("");
  });

  it("does not recognize a storage marker nested inside an unrelated path", () => {
    expect(
      storageKeyFromUrl(`${window.location.origin}/proxy/api/storage/files/workspaces/ws/a.png`)
    ).toBe("");
  });
});

describe("offline file fallback authority", () => {
  it.each([401, 403, 404])("does not expose cached bytes after HTTP %s", async (status) => {
    createWorkspaceFileDownloadUrl.mockRejectedValue(
      Object.assign(new Error(`HTTP ${status}`), { status })
    );
    cachedWorkspaceFileObjectUrl.mockResolvedValue("blob:stale-private-copy");

    await expect(resolveWorkspaceFileUrl("workspaces/ws/private.pdf")).rejects.toMatchObject({
      status,
    });
    expect(cachedWorkspaceFileObjectUrl).not.toHaveBeenCalled();
    expect(evictCachedWorkspaceFiles).toHaveBeenCalledWith(
      ["workspaces/ws/private.pdf"],
      "user-a"
    );
  });

  it.each([408, 425, 429, 503])("uses cached bytes for retryable HTTP %s", async (status) => {
    createWorkspaceFileDownloadUrl.mockRejectedValue(
      Object.assign(new Error(`HTTP ${status}`), { status })
    );
    cachedWorkspaceFileObjectUrl.mockResolvedValue("blob:offline-copy");

    await expect(resolveWorkspaceFileUrl(`workspaces/ws/${status}.pdf`)).resolves.toBe(
      "blob:offline-copy"
    );
  });

  it("uses cached bytes for a network failure but not an arbitrary client error", async () => {
    cachedWorkspaceFileObjectUrl.mockResolvedValue("blob:offline-copy");
    createWorkspaceFileDownloadUrl.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(resolveWorkspaceFileUrl("workspaces/ws/network.pdf")).resolves.toBe(
      "blob:offline-copy"
    );

    createWorkspaceFileDownloadUrl.mockRejectedValueOnce(
      Object.assign(new Error("Bad request"), { status: 400 })
    );
    await expect(resolveWorkspaceFileUrl("workspaces/ws/bad.pdf")).rejects.toMatchObject({
      status: 400,
    });
    expect(workspaceFileCacheFallbackAllowed({ status: 400 })).toBe(false);
  });

  it("reads the cache directly while the browser is offline", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    cachedWorkspaceFileObjectUrl.mockResolvedValue("blob:offline-copy");

    await expect(resolveWorkspaceFileUrl("workspaces/ws/offline.pdf")).resolves.toBe(
      "blob:offline-copy"
    );
    expect(createWorkspaceFileDownloadUrl).not.toHaveBeenCalled();
  });
});
