// @vitest-environment jsdom
//
// Undo/redo must survive the minimal-diff encoder. The old writer deleted and
// re-inserted the whole Y.Text on every edit; the new one applies a minimal
// prefix/suffix diff under the session's clientID, still inside the local-origin
// transact the UndoManager tracks — so a local edit remains a single undoable
// step and undo/redo restores the exact text.
import { describe, expect, it } from "vitest";
import {
  captureBlockTextLocalEdit,
  redoBlockTextLocalEdit,
  undoBlockTextLocalEdit,
} from "@/lib/collaborationCrdt";
import type { TextSpan } from "@/lib/types";

const plain = (text: string): TextSpan[] => [{ text }];

describe("block-text undo/redo with the minimal-diff encoder", () => {
  it("undoes and redoes a local edit to the exact text", async () => {
    const blockId = "undo-block-plain";
    await captureBlockTextLocalEdit({
      blockId,
      beforeRich: plain("Hello"),
      rich: plain("Hello world"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const undone = await undoBlockTextLocalEdit(blockId, "2026-01-01T00:00:01.000Z");
    expect(undone?.plainText).toBe("Hello");

    const redone = await redoBlockTextLocalEdit(blockId, "2026-01-01T00:00:02.000Z");
    expect(redone?.plainText).toBe("Hello world");
  });

  it("undo restores formatting, not just text", async () => {
    const blockId = "undo-block-format";
    await captureBlockTextLocalEdit({
      blockId,
      beforeRich: plain("bold me"),
      rich: [{ text: "bold me", bold: true }],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const undone = await undoBlockTextLocalEdit(blockId, "2026-01-01T00:00:01.000Z");
    expect(undone?.plainText).toBe("bold me");
    expect(undone?.rich.some((span) => span.bold)).toBe(false);

    const redone = await redoBlockTextLocalEdit(blockId, "2026-01-01T00:00:02.000Z");
    expect(redone?.rich.some((span) => span.bold)).toBe(true);
  });

  it("returns undefined when there is nothing to undo", async () => {
    expect(await undoBlockTextLocalEdit("never-touched-block")).toBeUndefined();
  });
});
