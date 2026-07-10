import { useEffect, useState } from "react";
import { createWorkspaceFileDownloadUrl } from "./storage";
import { safeStoredFileUrl } from "./urls";

const FILE_BUCKET = "files";
const DEFAULT_EXPIRES_IN = "30m";

const signedUrlCache = new Map<string, Promise<string>>();

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
    const parsed = new URL(raw, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    if (parsed.searchParams.has("token")) return "";
    const marker = `/api/storage/${encodeURIComponent(bucket)}/`;
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return "";
    return decodeStoragePath(parsed.pathname.slice(index + marker.length));
  } catch {
    return "";
  }
}

async function signedWorkspaceFileUrl(key: string, expiresIn = DEFAULT_EXPIRES_IN) {
  const cacheKey = `${expiresIn}:${key}`;
  const cached = signedUrlCache.get(cacheKey);
  if (cached) return cached;
  const request = createWorkspaceFileDownloadUrl({ key, expiresIn }).then((result) => result.url);
  signedUrlCache.set(cacheKey, request);
  return request;
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
    let cancelled = false;

    if (!key) {
      setResolvedUrl(nextSafeUrl);
      return () => {
        cancelled = true;
      };
    }

    setResolvedUrl("");
    signedWorkspaceFileUrl(key)
      .then((url) => {
        if (!cancelled) setResolvedUrl(url);
      })
      .catch(() => {
        if (!cancelled) setResolvedUrl("");
      });

    return () => {
      cancelled = true;
    };
  }, [value, dataPrefixKey]);

  return resolvedUrl;
}
