// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  blockUploadScope,
  fileBlockType,
  fileDragAutoScrollDelta,
} from "@/components/editor/fileDrop";

describe("editor external file drop helpers", () => {
  it("maps common media MIME types to their native block and storage scopes", () => {
    expect(fileBlockType(new File(["image"], "photo.png", { type: "image/png" }))).toBe("image");
    expect(fileBlockType(new File(["video"], "clip.mp4", { type: "video/mp4" }))).toBe("video");
    expect(fileBlockType(new File(["audio"], "voice.mp3", { type: "audio/mpeg" }))).toBe("audio");
    expect(fileBlockType(new File(["file"], "notes.pdf", { type: "application/pdf" }))).toBe("file");

    expect(blockUploadScope("image")).toBe("blocks/images");
    expect(blockUploadScope("video")).toBe("blocks/videos");
    expect(blockUploadScope("audio")).toBe("blocks/audio");
    expect(blockUploadScope("file")).toBe("blocks/files");
  });

  it("scrolls toward viewport edges with bounded pressure and stays still in the middle", () => {
    expect(fileDragAutoScrollDelta(100, 100, 700)).toBe(-18);
    expect(fileDragAutoScrollDelta(136, 100, 700)).toBe(-9);
    expect(fileDragAutoScrollDelta(400, 100, 700)).toBe(0);
    expect(fileDragAutoScrollDelta(664, 100, 700)).toBe(9);
    expect(fileDragAutoScrollDelta(700, 100, 700)).toBe(18);
  });
});
