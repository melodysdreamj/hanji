// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createWorkspaceFileDownloadUrl, currentUserId } = vi.hoisted(() => ({
  createWorkspaceFileDownloadUrl: vi.fn(),
  currentUserId: vi.fn(() => "user-a"),
}));

vi.mock("@/lib/storage", () => ({ createWorkspaceFileDownloadUrl }));
vi.mock("@/lib/edgebase", () => ({ currentUserId }));

import {
  cacheWorkspaceFileForOffline,
  cachedWorkspaceFileObjectUrl,
  clearOfflineWorkspaceFileCache,
  evictCachedWorkspaceFiles,
  hasCachedWorkspaceFile,
  offlineFileCacheUrl,
  offlineFileSizeAllowed,
  offlineWorkspaceFileCachingAllowed,
} from "@/lib/offlineFiles";

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

class MemoryCache {
  readonly entries = new Map<string, Response>();

  async put(input: RequestInfo | URL, response: Response) {
    this.entries.set(requestUrl(input), response.clone());
  }

  async match(input: RequestInfo | URL) {
    return this.entries.get(requestUrl(input))?.clone();
  }

  async delete(input: RequestInfo | URL) {
    return this.entries.delete(requestUrl(input));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class MemoryCacheStorage {
  readonly stores = new Map<string, MemoryCache>();

  async open(name: string) {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.stores.set(name, cache);
    }
    return cache;
  }

  async delete(name: string) {
    return this.stores.delete(name);
  }

  async keys() {
    return [...this.stores.keys()];
  }
}

const OFFLINE_CACHE = "hanji-offline-files-v1";
let cacheStorage: MemoryCacheStorage;

function fileResponse(bytes: number, body = "x") {
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(bytes) },
  });
}

beforeEach(() => {
  cacheStorage = new MemoryCacheStorage();
  vi.stubGlobal("caches", cacheStorage as unknown as CacheStorage);
  vi.stubGlobal("fetch", vi.fn());
  currentUserId.mockReset();
  currentUserId.mockReturnValue("user-a");
  createWorkspaceFileDownloadUrl.mockReset();
  createWorkspaceFileDownloadUrl.mockResolvedValue({
    url: "https://edgebase.example/signed",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline workspace file cache keys", () => {
  it("scopes a stable storage key to the authenticated user", () => {
    expect(
      offlineFileCacheUrl(
        "workspaces/ws/files/a b.png",
        "https://hanji.example",
        "user-a"
      )
    ).toBe(
      "https://hanji.example/__hanji_offline_file__/user-a/workspaces%2Fws%2Ffiles%2Fa%20b.png"
    );
  });

  it("fails closed while the passphrase lock requires sealed durable data", () => {
    window.localStorage.setItem("hanji.encryption.mode", "passphrase");
    expect(offlineWorkspaceFileCachingAllowed()).toBe(false);
  });

  it("only admits attachments with a trustworthy bounded byte length", () => {
    expect(offlineFileSizeAllowed("0")).toBe(true);
    expect(offlineFileSizeAllowed(String(100 * 1024 * 1024))).toBe(true);
    expect(offlineFileSizeAllowed(String(100 * 1024 * 1024 + 1))).toBe(false);
    expect(offlineFileSizeAllowed(null)).toBe(false);
    expect(offlineFileSizeAllowed("12.5")).toBe(false);
    expect(offlineFileSizeAllowed("-1")).toBe(false);
  });
});

describe("offline workspace file cache lifecycle", () => {
  it("stores and clears real CacheStorage entries", async () => {
    vi.mocked(fetch).mockResolvedValue(fileResponse(1));
    await expect(cacheWorkspaceFileForOffline("workspaces/ws/a.pdf")).resolves.toBe(true);
    await expect(hasCachedWorkspaceFile("workspaces/ws/a.pdf")).resolves.toBe(true);

    await clearOfflineWorkspaceFileCache();
    await expect(hasCachedWorkspaceFile("workspaces/ws/a.pdf")).resolves.toBe(false);
  });

  it("selectively evicts a deleted attachment in the current user's scope", async () => {
    vi.mocked(fetch).mockResolvedValue(fileResponse(1));
    await cacheWorkspaceFileForOffline("workspaces/ws/delete.pdf");
    await cacheWorkspaceFileForOffline("workspaces/ws/keep.pdf");

    await evictCachedWorkspaceFiles(["workspaces/ws/delete.pdf"]);

    await expect(hasCachedWorkspaceFile("workspaces/ws/delete.pdf")).resolves.toBe(false);
    await expect(hasCachedWorkspaceFile("workspaces/ws/keep.pdf")).resolves.toBe(true);
  });

  it("cannot resurrect a selectively evicted attachment from an in-flight download", async () => {
    let finishFetch!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        finishFetch = resolve;
      })
    );
    const pending = cacheWorkspaceFileForOffline("workspaces/ws/deleted-race.pdf");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await evictCachedWorkspaceFiles(["workspaces/ws/deleted-race.pdf"]);
    finishFetch(fileResponse(1));

    await expect(pending).resolves.toBe(false);
    await expect(hasCachedWorkspaceFile("workspaces/ws/deleted-race.pdf")).resolves.toBe(false);
  });

  it("does not expose a blob URL when targeted eviction wins an in-flight cache read", async () => {
    const cache = await cacheStorage.open(OFFLINE_CACHE);
    let finishBlob!: (blob: Blob) => void;
    const blob = vi.fn(
      () =>
        new Promise<Blob>((resolve) => {
          finishBlob = resolve;
        })
    );
    cache.match = vi.fn(async () => ({ blob }) as unknown as Response);
    const createObjectURL = vi.fn(() => "blob:must-not-escape");
    const NativeURL = URL;
    class TestURL extends NativeURL {
      static createObjectURL = createObjectURL;
    }
    vi.stubGlobal("URL", TestURL);

    const pending = cachedWorkspaceFileObjectUrl("workspaces/ws/read-race.pdf");
    await vi.waitFor(() => expect(blob).toHaveBeenCalledTimes(1));
    await evictCachedWorkspaceFiles(["workspaces/ws/read-race.pdf"]);
    finishBlob(new Blob(["private"]));

    await expect(pending).resolves.toBe("");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("cannot repopulate the cache when logout clears it during a fetch", async () => {
    let finishFetch!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        finishFetch = resolve;
      })
    );
    const pending = cacheWorkspaceFileForOffline("workspaces/ws/race.pdf");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await clearOfflineWorkspaceFileCache();
    finishFetch(fileResponse(1));

    await expect(pending).resolves.toBe(false);
    await expect(hasCachedWorkspaceFile("workspaces/ws/race.pdf")).resolves.toBe(false);
  });

  it("removes a late put that finishes after cache clearing began", async () => {
    const cache = await cacheStorage.open(OFFLINE_CACHE);
    const originalPut = cache.put.bind(cache);
    let finishPut!: () => void;
    const putGate = new Promise<void>((resolve) => {
      finishPut = resolve;
    });
    cache.put = vi.fn(async (input: RequestInfo | URL, response: Response) => {
      await putGate;
      await originalPut(input, response);
    });
    vi.mocked(fetch).mockResolvedValue(fileResponse(1));
    const pending = cacheWorkspaceFileForOffline("workspaces/ws/late-put.pdf");
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(1));

    const clearing = clearOfflineWorkspaceFileCache();
    finishPut();
    await clearing;

    await expect(pending).resolves.toBe(false);
    expect(cache.entries.size).toBe(0);
  });

  it("cannot persist plaintext when passphrase mode turns on mid-download", async () => {
    let finishFetch!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        finishFetch = resolve;
      })
    );
    const pending = cacheWorkspaceFileForOffline("workspaces/ws/rekey.pdf");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    window.localStorage.setItem("hanji.encryption.mode", "passphrase");
    finishFetch(fileResponse(1));

    await expect(pending).resolves.toBe(false);
    const cache = await cacheStorage.open(OFFLINE_CACHE);
    expect(cache.entries.size).toBe(0);
  });

  it("fails closed when the authenticated identity changes mid-download", async () => {
    let finishFetch!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        finishFetch = resolve;
      })
    );
    const pending = cacheWorkspaceFileForOffline("workspaces/ws/private.pdf");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    currentUserId.mockReturnValue("user-b");
    finishFetch(fileResponse(1));

    await expect(pending).resolves.toBe(false);
    await expect(hasCachedWorkspaceFile("workspaces/ws/private.pdf")).resolves.toBe(false);
  });

  it("never exposes one user's cached bytes to a different identity", async () => {
    vi.mocked(fetch).mockResolvedValue(fileResponse(1));
    await cacheWorkspaceFileForOffline("workspaces/ws/private.pdf");
    currentUserId.mockReturnValue("user-b");

    await expect(hasCachedWorkspaceFile("workspaces/ws/private.pdf")).resolves.toBe(false);
  });

  it("evicts the oldest entry when the count limit is exceeded", async () => {
    const cache = await cacheStorage.open(OFFLINE_CACHE);
    for (let index = 0; index < 500; index += 1) {
      await cache.put(
        offlineFileCacheUrl(`workspaces/ws/${index}.bin`, undefined, "user-a"),
        fileResponse(1)
      );
    }
    vi.mocked(fetch).mockResolvedValue(fileResponse(1));

    await expect(cacheWorkspaceFileForOffline("workspaces/ws/new.bin")).resolves.toBe(true);
    expect(await cache.keys()).toHaveLength(500);
    expect(
      await cache.match(offlineFileCacheUrl("workspaces/ws/0.bin", undefined, "user-a"))
    ).toBeUndefined();
    expect(
      await cache.match(offlineFileCacheUrl("workspaces/ws/new.bin", undefined, "user-a"))
    ).toBeDefined();
  });

  it("evicts oldest entries when the aggregate byte limit is exceeded", async () => {
    const cache = await cacheStorage.open(OFFLINE_CACHE);
    const hundredMb = 100 * 1024 * 1024;
    for (let index = 0; index < 5; index += 1) {
      await cache.put(
        offlineFileCacheUrl(`workspaces/ws/large-${index}.bin`, undefined, "user-a"),
        fileResponse(hundredMb, "")
      );
    }
    vi.mocked(fetch).mockResolvedValue(fileResponse(1));

    await cacheWorkspaceFileForOffline("workspaces/ws/tail.bin");
    expect(await cache.keys()).toHaveLength(5);
    expect(
      await cache.match(offlineFileCacheUrl("workspaces/ws/large-0.bin", undefined, "user-a"))
    ).toBeUndefined();
  });
});
