import { describe, expect, it } from "vitest";
import {
  isImageAttachment,
  isPdfAttachment,
  isPreviewableImageAttachment,
} from "@/components/database/files";

describe("database attachment classification", () => {
  it("recognizes images from MIME, data URLs, names, and source URLs", () => {
    expect(isImageAttachment({ id: "mime", name: "renamed", url: "/file", type: "image/png" })).toBe(true);
    expect(isImageAttachment({ id: "data", name: "renamed", url: "data:image/webp;base64,AA==" })).toBe(true);
    expect(isImageAttachment({ id: "name", name: "preview.JPG", url: "/opaque" })).toBe(true);
    expect(isImageAttachment({ id: "url", name: "preview", url: "https://files.example/photo.png?token=x" })).toBe(true);
  });

  it("recognizes PDFs without treating other documents as PDFs", () => {
    expect(isPdfAttachment({ id: "mime", name: "renamed", url: "/file", type: "application/pdf; charset=binary" })).toBe(true);
    expect(isPdfAttachment({ id: "data", name: "renamed", url: "data:application/pdf;base64,JVBERi0=" })).toBe(true);
    expect(isPdfAttachment({ id: "name", name: "manual.PDF", url: "/opaque" })).toBe(true);
    expect(isPdfAttachment({ id: "url", name: "manual", url: "https://files.example/manual.pdf?token=x" })).toBe(true);
    expect(isPdfAttachment({ id: "other", name: "manual.docx", url: "/manual.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe(false);
  });

  it("keeps active SVG images on the download-only path", () => {
    const svg = { id: "svg", name: "diagram.svg", url: "/opaque", type: "image/svg+xml" };
    expect(isImageAttachment(svg)).toBe(true);
    expect(isPreviewableImageAttachment(svg)).toBe(false);
    expect(isPreviewableImageAttachment({ id: "png", name: "diagram.png", url: "/opaque", type: "image/png" })).toBe(true);
  });
});
