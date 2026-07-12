// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { uploadWorkspaceFile } = vi.hoisted(() => ({
  uploadWorkspaceFile: vi.fn(async () => ({
    key: "workspaces/ws/icons/uploaded.png",
    url: "/api/storage/files/workspaces/ws/icons/uploaded.png",
    name: "uploaded.png",
    type: "image/png",
    size: 4,
  })),
}));

vi.mock("@/lib/storage", () => ({ uploadWorkspaceFile }));

import { EmojiPicker } from "@/components/EmojiPicker";
import type { WorkspaceFileTarget } from "@/lib/storage";

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function renderPicker(uploadTarget?: WorkspaceFileTarget) {
  const onPickImage = vi.fn();
  const result = render(
    <EmojiPicker
      uploadTarget={uploadTarget}
      onPick={vi.fn()}
      onPickImage={onPickImage}
      onClose={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole("tab", { name: "Image" }));
  return { ...result, onPickImage };
}

describe("EmojiPicker device-upload lifecycle guard", () => {
  it.each([
    ["a missing target", undefined],
    ["a database-only target", { databaseId: "db-1" }],
    ["a property target without its row page", { databaseId: "db-1", propertyId: "files" }],
    ["a whitespace page target", { pageId: "   " }],
  ] satisfies Array<[string, WorkspaceFileTarget | undefined]>) (
    "hides device upload for %s while preserving external image URLs",
    (_label, uploadTarget) => {
      const { container, onPickImage } = renderPicker(uploadTarget);

      expect(screen.queryByRole("button", { name: "Upload file" })).toBeNull();
      expect(container.querySelector('input[type="file"]')).toBeNull();

      fireEvent.change(screen.getByRole("textbox", { name: "Image icon link" }), {
        target: { value: "https://images.example/icon.png" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));

      expect(onPickImage).toHaveBeenCalledWith("https://images.example/icon.png");
      expect(uploadWorkspaceFile).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["page", { pageId: "page-1" }],
    ["block", { blockId: "block-1" }],
  ] satisfies Array<[string, WorkspaceFileTarget]>) (
    "allows and binds device upload for a tracked %s target",
    async (_label, uploadTarget) => {
      const { container, onPickImage } = renderPicker(uploadTarget);
      expect(screen.getByRole("button", { name: "Upload file" })).toBeTruthy();

      const input = container.querySelector<HTMLInputElement>('input[type="file"]');
      expect(input).toBeTruthy();
      const file = new File(["icon"], "icon.png", { type: "image/png" });
      fireEvent.change(input!, { target: { files: [file] } });

      await waitFor(() => {
        expect(uploadWorkspaceFile).toHaveBeenCalledWith(
          file,
          "icons",
          uploadTarget,
          expect.objectContaining({ onProgress: expect.any(Function) })
        );
      });
      await waitFor(() => {
        expect(onPickImage).toHaveBeenCalledWith(
          "/api/storage/files/workspaces/ws/icons/uploaded.png"
        );
      });
    }
  );
});
