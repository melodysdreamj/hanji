import { i18next } from "@/i18n";
import { isUnsafeWorkspaceFileError } from "@/lib/fileSecurity";
import type { UploadProgress } from "@/lib/storage";
import type { BlockType } from "@/lib/types";

export type DroppedFileBlockType = Extract<BlockType, "image" | "video" | "audio" | "file">;
export type FileDropPlacement = "before" | "after" | "replace";
export type BlockUploadProgress = UploadProgress & { fileName: string };

export function dataTransferHasFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("Files");
}

export function droppedFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.files).filter((file) => file.size > 0);
}

export function fileBlockType(file: File): DroppedFileBlockType {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}

export function blockUploadScope(type: DroppedFileBlockType) {
  if (type === "image") return "blocks/images";
  if (type === "video") return "blocks/videos";
  if (type === "audio") return "blocks/audio";
  return "blocks/files";
}

export function blockUploadErrorMessage(error: unknown, fileName: string) {
  const message = error instanceof Error ? error.message.trim() : "";
  if (/^file is too large\.?$/i.test(message)) return i18next.t("blockItem:uploadFileTooLarge");
  if (isUnsafeWorkspaceFileError(error)) return i18next.t("blockItem:uploadUnsafeFileType");
  if (message) console.error("Block file upload failed:", error);
  return fileName
    ? i18next.t("blockItem:uploadFailed", { fileName })
    : i18next.t("blockItem:uploadFailedUnknown");
}

export function blockUploadProgressLabel(progress: UploadProgress) {
  if (progress.phase === "preparing") return i18next.t("blockItem:uploadPreparing");
  if (progress.phase === "finalizing") return i18next.t("blockItem:uploadFinalizing");
  if (progress.phase === "complete") return i18next.t("blockItem:uploadComplete");
  return i18next.t("blockItem:uploadUploading");
}

export function fileDragAutoScrollDelta(
  clientY: number,
  viewportTop: number,
  viewportBottom: number,
  edgeSize = 72,
  maxStep = 18
) {
  if (viewportBottom <= viewportTop || edgeSize <= 0 || maxStep <= 0) return 0;
  if (clientY < viewportTop + edgeSize) {
    const pressure = Math.min(1, Math.max(0, (viewportTop + edgeSize - clientY) / edgeSize));
    return -Math.max(1, Math.round(maxStep * pressure));
  }
  if (clientY > viewportBottom - edgeSize) {
    const pressure = Math.min(1, Math.max(0, (clientY - (viewportBottom - edgeSize)) / edgeSize));
    return Math.max(1, Math.round(maxStep * pressure));
  }
  return 0;
}
