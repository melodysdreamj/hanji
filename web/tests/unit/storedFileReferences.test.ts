import { describe, expect, it } from "vitest";

import {
  hasDatabaseTemplateStoredFileReference,
  hasStoredFileReference,
} from "@/lib/storedFileReferences";

describe("stored file reference detection", () => {
  it.each([
    "workspaces/ws-1/blocks/files/upload.bin",
    "/api/storage/files/workspaces/ws-1/blocks/files/upload.bin",
    "http://localhost/api/storage/files/workspaces/ws-1/blocks/files/upload.bin",
  ])("detects a local storage locator: %s", (value) => {
    expect(hasStoredFileReference({ nested: [{ url: value }] })).toBe(true);
  });

  it("detects upload ids even when a legacy locator is absent", () => {
    expect(hasStoredFileReference({ children: [{ content: { fileUploadId: "upload-1" } }] }))
      .toBe(true);
  });

  it("does not block external links or ordinary block ids", () => {
    expect(hasStoredFileReference({
      id: "block-1",
      content: {
        rich: [{ text: "Open", href: "https://example.com/api/docs" }],
        image: "https://images.example.com/photo.png",
        samePathElsewhere: "https://example.com/api/storage/files/public.png",
        proxy: "https://example.com/proxy/api/storage/files/public.png",
      },
    })).toBe(false);
  });

  it("does not mistake literal storage-looking prose for an attachment", () => {
    expect(hasStoredFileReference({
      rich: [
        { text: "Document workspaces/ws-1/blocks/files/example.bin here" },
        { text: "http://localhost/api/storage/files/workspaces/ws-1/example.png" },
      ],
      caption: "workspaces/ws-1/caption.txt",
      plainText: "/api/storage/files/workspaces/ws-1/plain.txt",
    })).toBe(false);
  });

  it("handles cyclic clipboard-like objects without recursing forever", () => {
    const value: Record<string, unknown> = { content: { rich: [] } };
    value.self = value;
    expect(hasStoredFileReference(value)).toBe(false);
  });
});

describe("database template stored file detection", () => {
  const schema = [
    { id: "notes", type: "rich_text" },
    { id: "files", type: "files" },
  ];

  it("ignores a path literal in prose but detects a legacy raw files value", () => {
    expect(hasDatabaseTemplateStoredFileReference({
      properties: { notes: "workspaces/ws-1/files/literal.txt" },
    }, schema)).toBe(false);
    expect(hasDatabaseTemplateStoredFileReference({
      properties: { files: ["workspaces/ws-1/files/real.txt"] },
    }, schema)).toBe(true);
  });

  it("detects stored files in template chrome and blocks", () => {
    expect(hasDatabaseTemplateStoredFileReference({
      icon: "/api/storage/files/workspaces/ws-1/icons/template.png",
    }, schema)).toBe(true);
    expect(hasDatabaseTemplateStoredFileReference({
      blocks: [{ type: "file", content: { uploadId: "upload-1" } }],
    }, schema)).toBe(true);
  });
});
