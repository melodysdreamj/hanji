// Native Hanji export/import client helpers — turn an .hanji.json envelope
// into a downloaded file, and read one back for import. Files are excluded from
// the format by design; the backend strips attachments to placeholders.

import {
  exportPageNativeRemote,
  exportWorkspaceNativeRemote,
  type HanjiExportDocument,
} from "@/lib/edgebase";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { Page } from "@/lib/types";

export const HANJI_FILE_EXT = ".hanji.json";
export const NATIVE_FORMAT = "hanji.export";

function safeFileStem(name: string) {
  return (
    name
      .replace(/[\\/:*?"<>|#\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "hanji"
  );
}

// YYYY-MM-DD in local time, for the filename suffix.
function todayStamp() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function downloadHanjiDocument(stem: string, document_: HanjiExportDocument) {
  const blob = new Blob([JSON.stringify(document_)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileStem(stem)}-${todayStamp()}${HANJI_FILE_EXT}`;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Export a single page/database subtree to a downloaded file. Returns the
// warnings so the caller can surface a "some files were left as placeholders"
// notice.
export async function exportPageAsNative(page: Page) {
  const result = await exportPageNativeRemote(page.id);
  downloadHanjiDocument(pageDisplayTitle(page), result.document);
  return { counts: result.counts, warnings: result.warnings };
}

export async function exportWorkspaceAsNative(workspaceId: string, workspaceName?: string) {
  const result = await exportWorkspaceNativeRemote(workspaceId);
  downloadHanjiDocument(workspaceName || "workspace", result.document);
  return { counts: result.counts, warnings: result.warnings };
}

export function isHanjiFile(file: File) {
  return /\.hanji\.json$/i.test(file.name) || /\.hanji$/i.test(file.name);
}

function sourceFingerprint(parts: Array<string | number>) {
  // This is an ephemeral stale-response key, not a credential hash. FNV-1a
  // keeps tokens out of React state/DOM while ensuring any credential change
  // invalidates the preview fetched with the previous one.
  let hash = 0x811c9dc5;
  for (const char of parts.join("\u0000")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function hanjiFileSourceFingerprint(file: File) {
  return `file:${sourceFingerprint([file.name, file.size, file.lastModified, file.type])}`;
}

export function hanjiRemoteSourceFingerprint(
  baseUrl: string,
  workspaceId: string,
  token?: string
) {
  let normalizedBase = baseUrl.trim();
  try {
    normalizedBase = new URL(baseUrl).origin;
  } catch {
    // Keep the raw trimmed input in the fingerprint; fetch will report the
    // invalid URL if the user submits it.
  }
  return `live:${sourceFingerprint([normalizedBase, workspaceId.trim(), token?.trim() ?? ""])}`;
}

// Parse a user-provided file into a validated native document, or throw a
// human-readable error. Discriminates on the `format` field so a plain .json
// (e.g. an instance backup snapshot) is not mistaken for a native export.
export async function readHanjiFile(file: File): Promise<HanjiExportDocument> {
  const text = await file.text();
  return parseHanjiDocument(text);
}

export function parseHanjiDocument(text: string): HanjiExportDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  if (!isHanjiDocument(parsed)) {
    throw new Error("This is not an Hanji export file.");
  }
  return parsed;
}

export function isHanjiDocument(value: unknown): value is HanjiExportDocument {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.format !== NATIVE_FORMAT) return false;
  const entities = record.entities as Record<string, unknown> | undefined;
  return !!entities && Array.isArray(entities.pages);
}

// ─── Phase 2: live pull from another Hanji instance ────────────────────────
// Fetch a native export straight from a remote Hanji instance in the browser
// (no server-side SSRF concern — this is a same-origin-policy fetch from the
// user's browser, which can reach a Docker/dev instance the backend's SSRF
// guard would block). The remote must permit CORS from this origin and accept
// the pasted token; the file-based path is always available as a fallback.
export async function fetchRemoteHanjiExport(
  baseUrl: string,
  workspaceId: string,
  token?: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<HanjiExportDocument> {
  let endpoint: string;
  try {
    endpoint = new URL("/api/functions/import-export", baseUrl).toString();
  } catch {
    throw new Error("That is not a valid Hanji URL.");
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 15_000);
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      credentials: token ? "omit" : "include",
      body: JSON.stringify({ action: "exportWorkspaceNative", workspaceId }),
      signal: controller.signal,
    });
  } catch {
    if (timedOut) {
      throw new Error("The remote Hanji instance did not respond in time.");
    }
    if (options.signal?.aborted) {
      throw new DOMException("The remote export request was cancelled.", "AbortError");
    }
    throw new Error(
      "Couldn't reach the remote Hanji instance. Check the URL and that it allows requests from here (CORS)."
    );
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The remote Hanji instance rejected the token. Paste a valid access token.");
  }
  if (!response.ok) {
    throw new Error(`The remote Hanji instance responded ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The remote response was not JSON.");
  }
  const document_ = (payload as { document?: unknown })?.document;
  if (!isHanjiDocument(document_)) {
    throw new Error("The remote response did not contain an Hanji export.");
  }
  return document_;
}

// A short "n pages · m databases · k blocks" summary for the import preview.
export function summarizeDocument(document_: HanjiExportDocument): string {
  const counts = document_.counts ?? {};
  const parts: string[] = [];
  const push = (key: string, label: string) => {
    const value = counts[key];
    if (typeof value === "number" && value > 0) parts.push(`${value} ${label}`);
  };
  push("pages", "pages");
  push("databases", "databases");
  push("blocks", "blocks");
  push("comments", "comments");
  return parts.join(" · ");
}
