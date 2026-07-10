"use client";

import {
  completeFileUploadRemote,
  createFileDownloadUrlRemote,
  deleteFileUploadRemote,
  ensureAuth,
  getClient,
  prepareFileUploadRemote,
} from "./edgebase";

const FILE_BUCKET = "files";
const WS_KEY = "notionlike.workspaceId";
const MULTIPART_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024;

export interface UploadedWorkspaceFile {
  key: string;
  url: string;
  name: string;
  type?: string;
  size?: number;
}

export interface WorkspaceFileTarget {
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
}

export type UploadProgressPhase = "preparing" | "uploading" | "finalizing" | "complete";

export interface UploadProgress {
  phase: UploadProgressPhase;
  percent: number;
  loaded?: number;
  total?: number;
}

export interface UploadWorkspaceFileOptions {
  onProgress?: (progress: UploadProgress) => void;
}

interface MultipartUploadPart {
  partNumber: number;
  etag: string;
}

function reportProgress(
  options: UploadWorkspaceFileOptions | undefined,
  progress: UploadProgress
) {
  options?.onProgress?.({
    ...progress,
    percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
  });
}

async function uploadWithSignedUrl(
  uploadUrl: string,
  key: string,
  file: File,
  metadata: Record<string, string>,
  _contentType?: string,
  onProgress?: (progress: { loaded: number; total: number; percent: number }) => void
) {
  const form = new FormData();
  form.append("file", file, key);
  form.append("key", key);
  form.append("customMetadata", JSON.stringify(metadata));

  if (typeof XMLHttpRequest !== "undefined") {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", uploadUrl);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress?.({
          loaded: event.loaded,
          total: event.total,
          percent: (event.loaded / Math.max(1, event.total)) * 100,
        });
      };
      xhr.onerror = () => reject(new Error("Upload failed."));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        let message = `Upload failed: ${xhr.status}`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { message?: string };
          if (parsed.message) message = parsed.message;
        } catch {
          /* Keep the HTTP fallback message. */
        }
        reject(new Error(message));
      };
      xhr.send(form);
    });
    return;
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(error?.message || `Upload failed: ${response.status}`);
  }
}

function signedMultipartEndpoint(uploadUrl: string, action: "create" | "upload-part" | "complete" | "abort", key: string) {
  const url = new URL(uploadUrl);
  const token = url.searchParams.get("token");
  const signedKey = url.searchParams.get("key");
  if (!token) throw new Error("Signed multipart upload requires an upload token.");
  if (signedKey && signedKey !== key) throw new Error("Signed multipart upload key mismatch.");
  if (!url.pathname.endsWith("/upload")) {
    throw new Error("Signed multipart upload URL is invalid.");
  }
  url.pathname = url.pathname.replace(/\/upload$/, `/multipart/${action}`);
  url.search = "";
  url.searchParams.set("token", token);
  url.searchParams.set("key", key);
  return url.toString();
}

async function readUploadResponseJson<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* Keep the fallback message below. */
    }
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
        ? parsed.message
        : `${fallback}: ${response.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

async function postSignedMultipartJson<T>(
  uploadUrl: string,
  action: "create" | "complete" | "abort",
  key: string,
  body: Record<string, unknown>
) {
  const response = await fetch(signedMultipartEndpoint(uploadUrl, action, key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readUploadResponseJson<T>(response, `Multipart ${action} failed`);
}

async function uploadWithSignedMultipart(
  uploadUrl: string,
  key: string,
  file: File,
  metadata: Record<string, string>,
  contentType: string | undefined,
  onProgress?: (progress: { loaded: number; total: number; percent: number }) => void
) {
  let uploadId = "";
  try {
    const created = await postSignedMultipartJson<{ uploadId: string; key: string }>(
      uploadUrl,
      "create",
      key,
      {
        key,
        contentType: contentType || file.type || "application/octet-stream",
        customMetadata: metadata,
      }
    );
    uploadId = created.uploadId;
    if (!uploadId) throw new Error("Multipart upload did not return an upload id.");

    const parts: MultipartUploadPart[] = [];
    for (let start = 0, partNumber = 1; start < file.size; partNumber += 1) {
      const end = Math.min(start + MULTIPART_PART_SIZE_BYTES, file.size);
      const chunk = file.slice(start, end);
      const partUrl = signedMultipartEndpoint(uploadUrl, "upload-part", key);
      const url = new URL(partUrl);
      url.searchParams.set("uploadId", uploadId);
      url.searchParams.set("partNumber", String(partNumber));
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": contentType || file.type || "application/octet-stream" },
        body: chunk,
      });
      const part = await readUploadResponseJson<MultipartUploadPart>(response, `Multipart part ${partNumber} failed`);
      parts.push({ partNumber: part.partNumber, etag: part.etag });
      start = end;
      onProgress?.({
        loaded: start,
        total: file.size,
        percent: (start / Math.max(1, file.size)) * 100,
      });
    }

    await postSignedMultipartJson(uploadUrl, "complete", key, {
      uploadId,
      key,
      parts,
    });
  } catch (error) {
    if (uploadId) {
      await postSignedMultipartJson(uploadUrl, "abort", key, { uploadId, key }).catch(() => {});
    }
    throw error;
  }
}

export async function uploadWorkspaceFile(
  file: File,
  scope = "uploads",
  target: WorkspaceFileTarget = {},
  options: UploadWorkspaceFileOptions = {}
): Promise<UploadedWorkspaceFile> {
  await ensureAuth();
  reportProgress(options, { phase: "preparing", percent: 0 });
  const prepared = await prepareFileUploadRemote({
    workspaceId: localStorage.getItem(WS_KEY) ?? undefined,
    scope,
    ...target,
    name: file.name || "Untitled",
    size: file.size,
    contentType: file.type || undefined,
  });
  const upload = prepared.upload;
  const bucket = getClient().storage.bucket(upload.bucket || FILE_BUCKET);
  const metadata = {
    uploadId: upload.id,
    workspaceId: upload.workspaceId,
    pageId: upload.pageId ?? "",
    blockId: upload.blockId ?? "",
    databaseId: upload.databaseId ?? "",
    propertyId: upload.propertyId ?? "",
    originalName: file.name || "Untitled",
  };

  reportProgress(options, { phase: "uploading", percent: 5, loaded: 0, total: file.size });
  if (prepared.uploadUrl) {
    const uploadFn = file.size > MULTIPART_UPLOAD_THRESHOLD_BYTES ? uploadWithSignedMultipart : uploadWithSignedUrl;
    await uploadFn(prepared.uploadUrl, upload.key, file, metadata, file.type || undefined, (progress) => {
      reportProgress(options, {
        phase: "uploading",
        percent: 5 + progress.percent * 0.9,
        loaded: progress.loaded,
        total: progress.total,
      });
    });
  } else {
    await bucket.upload(upload.key, file, {
      contentType: file.type || undefined,
      customMetadata: metadata,
    });
  }

  reportProgress(options, { phase: "finalizing", percent: 96, loaded: file.size, total: file.size });
  const url = bucket.getUrl(upload.key);
  const completed = await completeFileUploadRemote({
    id: upload.id,
    key: upload.key,
    url,
  });

  reportProgress(options, { phase: "complete", percent: 100, loaded: file.size, total: file.size });
  return {
    key: completed.key,
    url: completed.url ?? url,
    name: completed.name || file.name || completed.key.split("/").at(-1) || "Untitled",
    type: file.type || undefined,
    size: file.size,
  };
}

export async function deleteWorkspaceFile(input: { key?: string; uploadId?: string }) {
  await ensureAuth();
  return deleteFileUploadRemote(input);
}

export async function createWorkspaceFileDownloadUrl(
  input: { key?: string; uploadId?: string; expiresIn?: string }
) {
  await ensureAuth();
  return createFileDownloadUrlRemote(input);
}
