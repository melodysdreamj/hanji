import { createWorkspaceFileDownloadUrl } from "./storage";
import { currentUserId } from "./edgebase";
import { localEncryptionMode, onLocalEncryptionModeChange } from "./localLock";

const OFFLINE_FILE_CACHE = "hanji-offline-files-v1";
const OFFLINE_FILE_CACHE_PREFIX = "/__hanji_offline_file__/";
const MAX_OFFLINE_FILES = 500;
const MAX_OFFLINE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_OFFLINE_CACHE_BYTES = 500 * 1024 * 1024;
export const CLEAR_OFFLINE_FILE_CACHE_EVENT = "hanji:clear-offline-file-cache";
let offlineFileCacheEpoch = 0;

function cacheApiAvailable() {
  return typeof caches !== "undefined" && typeof fetch !== "undefined";
}

export function offlineWorkspaceFileCachingAllowed() {
  // Passphrase mode promises that durable local data is sealed. Cache Storage
  // responses cannot be bound to that non-extractable/passphrase key without
  // buffering arbitrarily large files, so fail closed instead of persisting a
  // plaintext attachment beside an encrypted record cache.
  return localEncryptionMode() !== "passphrase";
}

export async function clearOfflineWorkspaceFileCache() {
  // Invalidate synchronously, before awaiting CacheStorage deletion. Any
  // download already in flight must fail its next context check and cannot
  // repopulate plaintext bytes after logout/re-key.
  offlineFileCacheEpoch += 1;
  if (typeof caches === "undefined") return;
  await caches.delete(OFFLINE_FILE_CACHE);
}

export async function evictCachedWorkspaceFiles(
  keys: Iterable<string>,
  ownerId = offlineFileCacheOwner()
) {
  const unique = [...new Set(keys)].filter(Boolean);
  if (unique.length === 0 || !cacheApiAvailable()) return;
  if (!ownerId) return;

  // Invalidate before touching CacheStorage. A matching download that started
  // earlier may finish after these deletes; the epoch check in its put path
  // then removes the late write instead of resurrecting deleted bytes.
  offlineFileCacheEpoch += 1;
  const cache = await caches.open(OFFLINE_FILE_CACHE);
  for (const key of unique) {
    await cache.delete(offlineFileCacheUrl(key, undefined, ownerId));
  }
}

if (typeof window !== "undefined") {
  window.addEventListener(CLEAR_OFFLINE_FILE_CACHE_EVENT, () => {
    void clearOfflineWorkspaceFileCache().catch(() => {});
  });
  onLocalEncryptionModeChange(() => {
    void clearOfflineWorkspaceFileCache().catch(() => {});
  });
}

export function offlineFileCacheUrl(key: string, origin?: string, ownerId = "") {
  const base = origin || (typeof window !== "undefined" ? window.location.origin : "https://hanji.invalid");
  const ownerPrefix = ownerId ? `${encodeURIComponent(ownerId)}/` : "";
  return new URL(
    `${OFFLINE_FILE_CACHE_PREFIX}${ownerPrefix}${encodeURIComponent(key)}`,
    base
  ).toString();
}

function offlineFileCacheOwner() {
  try {
    return currentUserId().trim();
  } catch {
    return "";
  }
}

function offlineFileCacheContextCurrent(epoch: number, ownerId: string) {
  return (
    epoch === offlineFileCacheEpoch &&
    !!ownerId &&
    ownerId === offlineFileCacheOwner() &&
    offlineWorkspaceFileCachingAllowed()
  );
}

async function trimOfflineFileCache(cache: Cache) {
  const keys = await cache.keys();
  const entries: Array<{ request: Request; bytes: number }> = [];
  let totalBytes = 0;
  for (const request of keys) {
    const response = await cache.match(request);
    const bytes = Number(response?.headers.get("content-length"));
    // A cached response without a trustworthy size cannot participate in the
    // bounded offline cache. Remove legacy/opaque entries fail-closed.
    if (!Number.isFinite(bytes) || bytes < 0) {
      await cache.delete(request);
      continue;
    }
    entries.push({ request, bytes });
    totalBytes += bytes;
  }
  while (entries.length > MAX_OFFLINE_FILES || totalBytes > MAX_OFFLINE_CACHE_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    await cache.delete(oldest.request);
    totalBytes -= oldest.bytes;
  }
}

export function offlineFileSizeAllowed(contentLength: string | null) {
  if (contentLength === null || !/^\d+$/.test(contentLength)) return false;
  const bytes = Number(contentLength);
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_OFFLINE_FILE_BYTES;
}

export async function cacheWorkspaceFileForOffline(key: string) {
  if (!key || !cacheApiAvailable() || !offlineWorkspaceFileCachingAllowed()) return false;
  const ownerId = offlineFileCacheOwner();
  if (!ownerId) return false;
  const epoch = offlineFileCacheEpoch;
  const signed = await createWorkspaceFileDownloadUrl({ key, expiresIn: "30m" });
  if (!offlineFileCacheContextCurrent(epoch, ownerId)) return false;
  const response = await fetch(signed.url, { credentials: "include" });
  if (!response.ok) return false;
  if (!offlineFileSizeAllowed(response.headers.get("content-length"))) return false;
  if (!offlineFileCacheContextCurrent(epoch, ownerId)) return false;
  const cache = await caches.open(OFFLINE_FILE_CACHE);
  if (!offlineFileCacheContextCurrent(epoch, ownerId)) return false;
  const cacheUrl = offlineFileCacheUrl(key, undefined, ownerId);
  await cache.put(cacheUrl, response.clone());
  if (!offlineFileCacheContextCurrent(epoch, ownerId)) {
    await cache.delete(cacheUrl);
    return false;
  }
  await trimOfflineFileCache(cache);
  if (!offlineFileCacheContextCurrent(epoch, ownerId)) {
    await cache.delete(cacheUrl);
    return false;
  }
  return true;
}

export async function cacheWorkspaceFilesForOffline(keys: Iterable<string>) {
  const unique = [...new Set(keys)].filter(Boolean);
  const results: boolean[] = [];
  // Keep this sequential: pinning a file-heavy page must not burst through
  // auth/storage rate limits or monopolize the browser connection pool.
  for (const key of unique) {
    results.push(await cacheWorkspaceFileForOffline(key).catch(() => false));
  }
  return results.every(Boolean);
}

export async function hasCachedWorkspaceFile(key: string) {
  if (!key || !cacheApiAvailable() || !offlineWorkspaceFileCachingAllowed()) return false;
  const ownerId = offlineFileCacheOwner();
  if (!ownerId) return false;
  const epoch = offlineFileCacheEpoch;
  const cache = await caches.open(OFFLINE_FILE_CACHE);
  const cached = await cache.match(offlineFileCacheUrl(key, undefined, ownerId));
  return !!cached && offlineFileCacheContextCurrent(epoch, ownerId);
}

export async function hasCachedWorkspaceFiles(keys: Iterable<string>) {
  for (const key of new Set(keys)) {
    if (!(await hasCachedWorkspaceFile(key))) return false;
  }
  return true;
}

export async function cachedWorkspaceFileObjectUrl(key: string) {
  if (
    !key ||
    !cacheApiAvailable() ||
    !offlineWorkspaceFileCachingAllowed() ||
    typeof URL.createObjectURL !== "function"
  ) return "";
  const ownerId = offlineFileCacheOwner();
  if (!ownerId) return "";
  const epoch = offlineFileCacheEpoch;
  const cache = await caches.open(OFFLINE_FILE_CACHE);
  const response = await cache.match(offlineFileCacheUrl(key, undefined, ownerId));
  if (!response || !offlineFileCacheContextCurrent(epoch, ownerId)) return "";
  const blob = await response.blob();
  if (!offlineFileCacheContextCurrent(epoch, ownerId)) return "";
  return URL.createObjectURL(blob);
}
