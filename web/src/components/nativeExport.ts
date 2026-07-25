// Native Hanji export/import client helpers — turn an .hanji.json envelope
// into a downloaded file, and read one back for import. Files are excluded from
// the format by design; the backend strips attachments to placeholders.

import {
  cancelNativeArchiveImportRemote,
  exportPageNativeArchiveRemote,
  exportPageNativeRemote,
  exportWorkspaceNativeArchiveRemote,
  exportWorkspaceNativeRemote,
  importNativeArchiveRemote,
  prepareNativeArchiveImportRemote,
  type HanjiExportDocument,
  type ImportNativeResult,
  type NativeArchiveImportInput,
  type NativeArchiveUploadGrant,
} from "@/lib/edgebase";
import {
  isLegacyHanjiNativeFileName,
  normalizeLegacyHanjiNativeDocument,
} from "@/lib/legacyNamespace";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { Page } from "@/lib/types";
import {
  NATIVE_ARCHIVE_LIMITS,
  isNativeArchiveFile,
  parseNativeArchive,
  saveNativeArchiveResponse,
  uploadNativeArchiveEntries,
  type ParsedNativeArchive,
} from "@/lib/nativeArchive";

export const HANJI_FILE_EXT = ".hanji.json";
export const HANJI_ARCHIVE_EXT = ".hanji.zip";
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

export async function exportPageAsNativeArchive(page: Page) {
  const response = await exportPageNativeArchiveRemote(page.id);
  await saveNativeArchiveResponse(
    response,
    `${safeFileStem(pageDisplayTitle(page))}-${todayStamp()}${HANJI_ARCHIVE_EXT}`
  );
}

export async function exportWorkspaceAsNativeArchive(
  workspaceId: string,
  workspaceName?: string
) {
  const response = await exportWorkspaceNativeArchiveRemote(workspaceId);
  await saveNativeArchiveResponse(
    response,
    `${safeFileStem(workspaceName || "workspace")}-${todayStamp()}${HANJI_ARCHIVE_EXT}`
  );
}

export function isHanjiFile(file: File) {
  return (
    isNativeArchiveFile(file) ||
    /\.hanji\.json$/i.test(file.name) ||
    /\.hanji$/i.test(file.name) ||
    isLegacyHanjiNativeFileName(file.name)
  );
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

export type HanjiImportFileSelection =
  | { kind: "json"; document: HanjiExportDocument }
  | { kind: "archive"; archive: ParsedNativeArchive };

export async function readHanjiImportFile(file: File): Promise<HanjiImportFileSelection> {
  if (isNativeArchiveFile(file)) {
    return { kind: "archive", archive: await parseNativeArchive(file) };
  }
  return { kind: "json", document: await readHanjiFile(file) };
}

export function createNativeArchiveBatchId() {
  return `web-${crypto.randomUUID()}`;
}

function archiveImportInput(input: {
  workspaceId: string;
  batchId: string;
  archive: ParsedNativeArchive;
}): NativeArchiveImportInput {
  return {
    workspaceId: input.workspaceId,
    batchId: input.batchId,
    document: input.archive.document,
    manifest: input.archive.manifest,
  };
}

function exactArchiveUploadEntries(
  archive: ParsedNativeArchive,
  grants: NativeArchiveUploadGrant[]
) {
  if (!Array.isArray(grants) || grants.length !== archive.manifest.files.length) {
    throw new Error("Archive upload grants do not exactly match the manifest.");
  }
  const grantsByFileId = new Map<string, NativeArchiveUploadGrant>();
  for (const grant of grants) {
    if (
      !grant
      || typeof grant.fileId !== "string"
      || grantsByFileId.has(grant.fileId)
      || typeof grant.id !== "string"
      || !grant.id
      || typeof grant.key !== "string"
      || !grant.key
      || typeof grant.uploadUrl !== "string"
      || !grant.uploadUrl
      || typeof grant.uploadExpiresAt !== "string"
      || !grant.uploadExpiresAt
      || !Number.isSafeInteger(grant.uploadMaxBytes)
    ) {
      throw new Error("Archive upload grants are invalid or duplicated.");
    }
    let url: URL;
    try {
      url = new URL(grant.uploadUrl);
    } catch {
      throw new Error(`Archive upload grant ${grant.fileId} has an invalid URL.`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Archive upload grant ${grant.fileId} has an invalid URL.`);
    }
    grantsByFileId.set(grant.fileId, grant);
  }
  const filesById = new Map(archive.files.map((file) => [file.id, file]));
  if (filesById.size !== archive.manifest.files.length) {
    throw new Error("Archive file slices do not exactly match the manifest.");
  }
  return archive.manifest.files.map((manifestFile) => {
    const file = filesById.get(manifestFile.id);
    const grant = grantsByFileId.get(manifestFile.id);
    if (
      !file
      || !grant
      || file.bytes !== manifestFile.bytes
      || file.blob.size !== manifestFile.bytes
      || file.contentType !== manifestFile.contentType
      || grant.uploadMaxBytes !== Math.max(1, manifestFile.bytes)
    ) {
      throw new Error(`Archive upload grant for ${manifestFile.id} does not match the manifest.`);
    }
    return {
      id: manifestFile.id,
      blob: file.blob,
      contentType: manifestFile.contentType,
      key: grant.key,
      name: manifestFile.name,
      uploadUrl: grant.uploadUrl,
    };
  });
}

export async function importParsedNativeArchive(input: {
  workspaceId: string;
  batchId: string;
  archive: ParsedNativeArchive;
}): Promise<ImportNativeResult> {
  const request = archiveImportInput(input);
  const prepared = await prepareNativeArchiveImportRemote(request);
  if (!prepared || prepared.batchId !== input.batchId || !Array.isArray(prepared.files)) {
    throw new Error("Archive import preparation returned the wrong batch.");
  }
  if (prepared.completed) {
    if (prepared.files.length !== 0) {
      throw new Error("Completed archive import preparation returned unexpected upload grants.");
    }
    return prepared.completed;
  }

  try {
    const entries = exactArchiveUploadEntries(input.archive, prepared.files);
    const uploaded = await uploadNativeArchiveEntries(entries, {
      concurrency: NATIVE_ARCHIVE_LIMITS.heavyConcurrency,
    });
    if (uploaded.failures.length > 0) {
      const ids = uploaded.failures.map((failure) => failure.id).join(", ");
      throw new Error(`Archive upload failed for ${ids}.`);
    }
  } catch (error) {
    await cancelNativeArchiveImportRemote(request).catch(() => undefined);
    throw error;
  }

  // Do not cancel after this point. A transport failure can hide a committed
  // result; the caller must retry this exact batch so the server can replay it.
  return importNativeArchiveRemote(request);
}

export function parseHanjiDocument(text: string): HanjiExportDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  const normalized = normalizeLegacyHanjiNativeDocument(parsed);
  if (!isHanjiDocument(normalized)) {
    throw new Error("This is not a Hanji export file.");
  }
  return normalized;
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
  const document_ = normalizeLegacyHanjiNativeDocument(
    (payload as { document?: unknown })?.document
  );
  if (!isHanjiDocument(document_)) {
    throw new Error("The remote response did not contain a Hanji export.");
  }
  return document_;
}

// A short "n pages · m databases · k blocks" summary for the import preview.
export function summarizeDocument(document_: { counts?: Record<string, number> }): string {
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
