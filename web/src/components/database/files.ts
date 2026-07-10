import type { FileAttachment } from "@/lib/types";

const IMAGE_EXT = /\.(avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function nameFromDataUrl(url: string) {
  const match = /^data:([^;,]+)/.exec(url);
  if (!match) return "Uploaded file";
  if (match[1].startsWith("image/")) return "Image";
  return match[1].split("/").at(-1) || "Uploaded file";
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function fileNameFromUrl(url: string) {
  const value = url.trim();
  if (!value) return "Untitled";
  if (value.startsWith("data:")) return nameFromDataUrl(value);
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return safeDecode(pathname) || parsed.hostname || "Untitled";
  } catch {
    return safeDecode(value.split(/[/?#]/).filter(Boolean).at(-1) ?? "") || "Untitled";
  }
}

function normalizeOne(value: unknown): FileAttachment | null {
  if (!value) return null;
  if (typeof value === "string") {
    const url = value.trim();
    return url ? { id: url, name: fileNameFromUrl(url), url } : null;
  }
  if (typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const key = asString(record.key) || asString(record.fileKey);
  const uploadId = asString(record.uploadId) || asString(record.fileUploadId);
  const bucket = asString(record.bucket) || asString(record.fileBucket);
  const sourceUrl = asString(record.sourceUrl);
  const url = asString(record.url) || asString(record.src) || asString(record.href) || sourceUrl || key;
  if (!url && !key && !uploadId) return null;

  const id = asString(record.id) || uploadId || key || url;
  const name = asString(record.name) || asString(record.fileName) || fileNameFromUrl(url);
  const type = asString(record.type) || asString(record.mimeType) || undefined;
  const size = typeof record.size === "number" && Number.isFinite(record.size)
    ? record.size
    : undefined;
  const notionFileSource = asString(record.notionFileSource) || undefined;
  const notionFileExpiryTime = asString(record.notionFileExpiryTime) || undefined;
  const notionFileCopied = typeof record.notionFileCopied === "boolean" ? record.notionFileCopied : undefined;

  return {
    id,
    key: key || undefined,
    uploadId: uploadId || undefined,
    bucket: bucket || undefined,
    name,
    url,
    type,
    size,
    sourceUrl: sourceUrl || undefined,
    notionFileSource,
    notionFileExpiryTime,
    notionFileCopied,
  };
}

export function normalizeFileAttachments(value: unknown): FileAttachment[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map(normalizeOne)
    .filter((item): item is FileAttachment => item !== null);
}

export function isImageAttachment(file: FileAttachment) {
  return (
    file.type?.startsWith("image/") ||
    file.url.startsWith("data:image/") ||
    IMAGE_EXT.test(file.url)
  );
}

export function firstImageAttachment(value: unknown) {
  return normalizeFileAttachments(value).find(isImageAttachment);
}

export function formatFileSize(size?: number) {
  if (size == null || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${Number((size / 1024 / 1024).toFixed(1))} MB`;
}
