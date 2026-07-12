// @vitest-environment jsdom
//
// H1 convergence: concurrent block-text edits must MERGE over one shared base,
// not concatenate it.
//
// The fix: a client seeds the block's base under a reserved deterministic
// clientID (so every client that starts from the same server content derives
// identical base items) and encodes each edit as a minimal prefix/suffix diff
// under its own clientID. Two clients' updates then share the base and Yjs
// converges character-by-character; the collaboration server merges via the
// same applyUpdate path (mergeBlockTextCrdtUpdates mirrors it).
import { describe, expect, it } from "vitest";
import {
  __buildBlockTextClientUpdateForTest as buildClientUpdate,
  createBlockTextCrdtUpdate,
  mergeBlockTextCrdtUpdates,
} from "@/lib/collaborationCrdt";
import type { TextSpan } from "@/lib/types";

const BLOCK_ID = "block-convergence";

function plain(text: string): TextSpan[] {
  return [{ text }];
}

describe("CRDT block-text convergence (H1)", () => {
  it("a lone update round-trips exactly", async () => {
    const update = await createBlockTextCrdtUpdate({
      blockId: BLOCK_ID,
      rich: plain("Hello world"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const merged = await mergeBlockTextCrdtUpdates([update], BLOCK_ID);
    expect(merged?.plainText).toBe("Hello world");
  });

  it("identical full-content encodes are idempotent (base kept once)", async () => {
    const a = await createBlockTextCrdtUpdate({
      blockId: BLOCK_ID,
      rich: plain("Shared base"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const b = await createBlockTextCrdtUpdate({
      blockId: BLOCK_ID,
      rich: plain("Shared base"),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const merged = await mergeBlockTextCrdtUpdates([a, b], BLOCK_ID);
    expect(merged?.plainText).toBe("Shared base");
  });

  it("two concurrent edits over a shared base CONVERGE, not concatenate", async () => {
    const base = plain("Hello world ");
    const a = await buildClientUpdate(BLOCK_ID, base, plain("Hello world Alice"));
    const b = await buildClientUpdate(BLOCK_ID, base, plain("Hello world Bob"));

    const merged = await mergeBlockTextCrdtUpdates([a, b], BLOCK_ID);
    const mergedReverse = await mergeBlockTextCrdtUpdates([b, a], BLOCK_ID);
    const text = merged?.plainText ?? "";

    // Order-independent (true CRDT convergence).
    expect(text).toBe(mergedReverse?.plainText);
    // The shared base survives exactly once — the H1 bug was
    // "Hello world Hello world" duplication.
    expect(text).not.toContain("Hello world Hello world");
    // Both editors' distinct suffixes survive (lossless).
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
    // Length is base + the two 5-char suffixes, never base twice.
    expect(text.length).toBe("Hello world ".length + "Alice".length + "Bob".length);
  });

  it("converges with concurrent formatting on a shared base", async () => {
    const base = plain("the quick brown fox");
    const a = await buildClientUpdate(BLOCK_ID, base, [
      { text: "the " },
      { text: "quick", bold: true },
      { text: " brown fox" },
    ]);
    const b = await buildClientUpdate(BLOCK_ID, base, [
      { text: "the quick brown " },
      { text: "fox", italic: true },
      { text: " jumps" },
    ]);

    const merged = await mergeBlockTextCrdtUpdates([a, b], BLOCK_ID);
    expect(merged?.plainText).toBe("the quick brown fox jumps");
    const rich = merged?.rich ?? [];
    expect(rich.find((span) => span.text.includes("quick"))?.bold).toBe(true);
    expect(rich.find((span) => span.text.includes("fox"))?.italic).toBe(true);
    // Base text is not duplicated by the merge.
    expect(merged?.plainText.match(/quick/g) ?? []).toHaveLength(1);
  });
});
