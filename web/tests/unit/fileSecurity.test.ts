import { describe, expect, it } from "vitest";
import {
  assertSafeWorkspaceUpload,
  isActiveContentFile,
  isSafeEmbedTarget,
  UnsafeWorkspaceFileError,
} from "@/lib/fileSecurity";

describe("workspace file security", () => {
  it.each([
    { name: "payload.html", type: "text/plain" },
    { name: "payload.txt", type: "text/html; charset=utf-8" },
    { name: "image.svg", type: "image/svg+xml" },
    { name: "feed.atom", type: "application/atom+xml" },
    { name: "worker.mjs", type: "application/octet-stream" },
  ])("rejects active content described by MIME or filename: $name", (file) => {
    expect(isActiveContentFile(file)).toBe(true);
    expect(() => assertSafeWorkspaceUpload(file)).toThrow(UnsafeWorkspaceFileError);
  });

  it.each([
    { name: "photo.png", type: "image/png" },
    { name: "clip.mp4", type: "video/mp4" },
    { name: "report.pdf", type: "application/pdf" },
    { name: "archive.zip", type: "application/zip" },
  ])("keeps inert supported files uploadable: $name", (file) => {
    expect(isActiveContentFile(file)).toBe(false);
    expect(() => assertSafeWorkspaceUpload(file)).not.toThrow();
  });
});

describe("embed target security", () => {
  const origin = "https://hanji.example";

  it.each([
    "/api/storage/files/workspaces/a/payload.html",
    "https://hanji.example/api/storage/files/workspaces/a/payload.html?token=x",
    "https://hanji.example/any-app-route",
    "javascript:alert(1)",
    "data:text/html,boom",
  ])("rejects app-origin or active embed targets: %s", (url) => {
    expect(isSafeEmbedTarget(url, origin)).toBe(false);
  });

  it("allows external http(s) embed targets", () => {
    expect(isSafeEmbedTarget("https://www.youtube.com/embed/abc", origin)).toBe(true);
    expect(isSafeEmbedTarget("http://localhost:9999/widget", origin)).toBe(true);
  });
});
