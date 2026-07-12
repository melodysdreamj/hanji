import { useEffect, useState } from "react";
import { createWorkspaceFileDownloadUrl, workspaceFileApiOrigin } from "./storage";
import { cachedWorkspaceFileObjectUrl, evictCachedWorkspaceFiles } from "./offlineFiles";
import { currentUserId } from "./edgebase";
import { safeStoredFileUrl } from "./urls";

const FILE_BUCKET = "files";
const DEFAULT_EXPIRES_IN = "30m";
const SIGNED_URL_REFRESH_SKEW_MS = 60_000;
const SIGNED_URL_CACHE_MAX_ENTRIES = 256;
export const CLEAR_SIGNED_FILE_URL_CACHE_EVENT = "hanji:clear-signed-file-url-cache";

interface SignedUrlCacheEntry {
  promise: Promise<string>;
  expiresAt: number;
  lastUsedAt: number;
}

const signedUrlCache = new Map<string, SignedUrlCacheEntry>();
let signedUrlCacheEpoch = 0;

function signedUrlOwner() {
  try {
    return currentUserId().trim();
  } catch {
    return "";
  }
}

function signedUrlContextCurrent(epoch: number, ownerId: string) {
  return epoch === signedUrlCacheEpoch && ownerId === signedUrlOwner();
}

function signedUrlContextChanged() {
  return Object.assign(new Error("Signed file access context changed."), {
    code: "SIGNED_FILE_CONTEXT_CHANGED",
  });
}

export function clearSignedWorkspaceFileUrlCache() {
  // Clearing credentials must invalidate promises already in flight, not only
  // entries that have reached the cache. This also fences logout -> login as
  // the same user after the underlying session/token has rotated.
  signedUrlCacheEpoch += 1;
  signedUrlCache.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener(CLEAR_SIGNED_FILE_URL_CACHE_EVENT, clearSignedWorkspaceFileUrlCache);
}

function decodeStoragePath(path: string) {
  return path
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

export function storageKeyFromUrl(value: string | undefined, bucket = FILE_BUCKET) {
  const raw = value?.trim() ?? "";
  if (!raw || !/^(https?:\/\/|\/)/i.test(raw)) return "";
  try {
    const appOrigin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const parsed = new URL(raw, appOrigin);
    const allowedOrigins = new Set([new URL(appOrigin).origin, workspaceFileApiOrigin()]);
    if (!allowedOrigins.has(parsed.origin)) return "";
    if (parsed.searchParams.has("token")) return "";
    const marker = `/api/storage/${encodeURIComponent(bucket)}/`;
    if (!parsed.pathname.startsWith(marker)) return "";
    return decodeStoragePath(parsed.pathname.slice(marker.length));
  } catch {
    return "";
  }
}

function fileAccessErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    code?: unknown;
    response?: { status?: unknown };
    status?: unknown;
    statusCode?: unknown;
  };
  for (const value of [record.status, record.statusCode, record.response?.status, record.code]) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 599) return parsed;
  }
  return null;
}

export function workspaceFileCacheFallbackAllowed(error: unknown) {
  const status = fileAccessErrorStatus(error);
  if (status !== null) {
    return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  }
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:network|failed to fetch|fetch failed|timed?\s*out|temporar(?:y|ily)|connection)/i.test(
    message
  );
}

function trimSignedUrlCache() {
  while (signedUrlCache.size > SIGNED_URL_CACHE_MAX_ENTRIES) {
    let oldestKey = "";
    let oldestUsedAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of signedUrlCache) {
      if (entry.lastUsedAt < oldestUsedAt) {
        oldestKey = key;
        oldestUsedAt = entry.lastUsedAt;
      }
    }
    if (!oldestKey) return;
    signedUrlCache.delete(oldestKey);
  }
}

export async function signedWorkspaceFileUrl(key: string, expiresIn = DEFAULT_EXPIRES_IN) {
  const ownerId = signedUrlOwner();
  const epoch = signedUrlCacheEpoch;
  // A cold auth restore may not have a principal yet. Do not cache that
  // credential under a shared anonymous bucket; the next signed-in render can
  // establish an owner-scoped entry.
  if (!ownerId) {
    const result = await createWorkspaceFileDownloadUrl({ key, expiresIn });
    if (!signedUrlContextCurrent(epoch, ownerId)) throw signedUrlContextChanged();
    return result.url;
  }
  const cacheKey = `${ownerId}:${expiresIn}:${key}`;
  const now = Date.now();
  const cached = signedUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > now + SIGNED_URL_REFRESH_SKEW_MS) {
    cached.lastUsedAt = now;
    const url = await cached.promise;
    if (!signedUrlContextCurrent(epoch, ownerId)) throw signedUrlContextChanged();
    return url;
  }
  if (cached) signedUrlCache.delete(cacheKey);

  const entry: SignedUrlCacheEntry = {
    // Treat the in-flight request as fresh so concurrent renders share it.
    expiresAt: Number.POSITIVE_INFINITY,
    lastUsedAt: now,
    promise: Promise.resolve(""),
  };
  entry.promise = createWorkspaceFileDownloadUrl({ key, expiresIn })
    .then((result) => {
      if (!signedUrlContextCurrent(epoch, ownerId)) {
        if (signedUrlCache.get(cacheKey) === entry) signedUrlCache.delete(cacheKey);
        throw signedUrlContextChanged();
      }
      const parsedExpiry = Date.parse(result.expiresAt);
      entry.expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now();
      return result.url;
    })
    .catch((error) => {
      // A transient 429/network failure must not poison this key until reload.
      if (signedUrlCache.get(cacheKey) === entry) signedUrlCache.delete(cacheKey);
      throw error;
    });
  signedUrlCache.set(cacheKey, entry);
  trimSignedUrlCache();
  return entry.promise;
}

export async function resolveWorkspaceFileUrl(key: string) {
  const cacheOwnerId = currentUserId();
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const cached = await cachedWorkspaceFileObjectUrl(key);
    if (cached) return cached;
  }
  try {
    return await signedWorkspaceFileUrl(key);
  } catch (error) {
    // A definitive authorization/not-found response is fresher authority than
    // local bytes. Only connectivity or explicitly retryable server failures
    // may use the offline copy while the browser reports itself online.
    if (!workspaceFileCacheFallbackAllowed(error)) {
      // A definitive auth/not-found response revokes local offline authority
      // too. Delete plaintext bytes before surfacing the server decision so a
      // later navigator.offline branch cannot resurrect the attachment.
      await evictCachedWorkspaceFiles([key], cacheOwnerId);
      throw error;
    }
    return cachedWorkspaceFileObjectUrl(key);
  }
}

export function useWorkspaceFileUrl(value: string | undefined, dataPrefixes: string[] = []) {
  const dataPrefixKey = dataPrefixes.join("\0");
  const safeUrl = safeStoredFileUrl(value, dataPrefixKey ? dataPrefixKey.split("\0") : []);
  // Never expose an unsigned storage URL, even for the first paint: direct
  // bucket reads are always denied (403), so a media/img tag mounted with the
  // raw URL fires a doomed request before the signed swap below lands.
  const [resolvedUrl, setResolvedUrl] = useState(() =>
    storageKeyFromUrl(safeUrl) ? "" : safeUrl
  );

  useEffect(() => {
    const prefixes = dataPrefixKey ? dataPrefixKey.split("\0") : [];
    const nextSafeUrl = safeStoredFileUrl(value, prefixes);
    const key = storageKeyFromUrl(nextSafeUrl);
    const requestOwnerId = signedUrlOwner();
    let cancelled = false;
    let offlineObjectUrl = "";

    if (!key) {
      setResolvedUrl(nextSafeUrl);
      return () => {
        cancelled = true;
      };
    }

    setResolvedUrl("");
    const invalidate = () => {
      cancelled = true;
      setResolvedUrl("");
    };
    window.addEventListener(CLEAR_SIGNED_FILE_URL_CACHE_EVENT, invalidate);
    resolveWorkspaceFileUrl(key)
      .then((url) => {
        if (url.startsWith("blob:")) offlineObjectUrl = url;
        if (!cancelled && requestOwnerId === signedUrlOwner()) setResolvedUrl(url);
        else if (offlineObjectUrl) URL.revokeObjectURL(offlineObjectUrl);
      })
      .catch(() => {
        if (!cancelled) setResolvedUrl("");
      });

    return () => {
      cancelled = true;
      window.removeEventListener(CLEAR_SIGNED_FILE_URL_CACHE_EVENT, invalidate);
      if (offlineObjectUrl) URL.revokeObjectURL(offlineObjectUrl);
    };
  }, [value, dataPrefixKey]);

  return resolvedUrl;
}
