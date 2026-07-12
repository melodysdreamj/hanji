// @vitest-environment jsdom
//
// H1 regression guard (#4): a client that joins AFTER a block has already been
// edited collaboratively must NOT re-seed a deterministic base from the block's
// current (grown) content. Doing so re-encodes the earlier client's characters
// under the reserved base clientID, so Yjs keeps them twice on merge and the
// shared region duplicates ("hello world" -> "hello world world!").
//
// The fix records the block's authoritative durable Yjs state
// (rememberBlockTextDurableState) and hydrates a freshly-created session from it
// instead of seeding, so a late joiner's edit is a minimal diff on top of the
// real shared base. This test drives the real session path through
// createBlockTextCrdtUpdateFromUndoSession and asserts order-independent
// convergence with no duplication.
import { describe, expect, it } from "vitest";
import {
  __buildBlockTextClientUpdateForTest as buildClientUpdate,
  createBlockTextCrdtUpdateFromUndoSession,
  mergeBlockTextCrdtUpdates,
  rememberBlockTextDurableState,
} from "@/lib/collaborationCrdt";
import type { TextSpan } from "@/lib/types";

function plain(text: string): TextSpan[] {
  return [{ text }];
}

describe("CRDT late-joiner convergence (#4)", () => {
  it("a late joiner hydrates from durable state and does not duplicate the shared base", async () => {
    const blockId = "block-late-joiner-basic";
    // Client A starts from pristine "hello" and types " world".
    const a = await buildClientUpdate(blockId, plain("hello"), plain("hello world"));

    // The durable store now holds A's authoritative Yjs state for this block.
    rememberBlockTextDurableState(blockId, a.updateBase64);

    // Client B opens the page (sees "hello world"), then types "!". This goes
    // through the real session encoder, which must hydrate from A's state.
    const b = await createBlockTextCrdtUpdateFromUndoSession({
      blockId,
      rich: plain("hello world!"),
      updatedAt: "",
    });

    const merged = await mergeBlockTextCrdtUpdates([a, b], blockId);
    const reverse = await mergeBlockTextCrdtUpdates([b, a], blockId);

    expect(merged?.plainText).toBe("hello world!");
    // Order-independent — a real CRDT merge.
    expect(merged?.plainText).toBe(reverse?.plainText);
    // The pre-existing " world" segment survives exactly once (the H1 bug
    // produced "hello world world!").
    expect((merged?.plainText.match(/world/g) ?? []).length).toBe(1);
  });

  it("a late joiner inserting into the middle of grown content does not duplicate words", async () => {
    const blockId = "block-late-joiner-middle";
    // Client A inserted "quick " into the middle of "The fox".
    const a = await buildClientUpdate(blockId, plain("The fox"), plain("The quick fox"));
    rememberBlockTextDurableState(blockId, a.updateBase64);

    // Client B joins, sees "The quick fox", and inserts "brown " before "fox".
    const b = await createBlockTextCrdtUpdateFromUndoSession({
      blockId,
      rich: plain("The quick brown fox"),
      updatedAt: "",
    });

    const merged = await mergeBlockTextCrdtUpdates([a, b], blockId);
    const reverse = await mergeBlockTextCrdtUpdates([b, a], blockId);
    expect(merged?.plainText).toBe("The quick brown fox");
    expect(merged?.plainText).toBe(reverse?.plainText);
    // Every word survives exactly once (no re-seeded base duplication).
    for (const word of ["The", "quick", "brown", "fox"]) {
      expect((merged?.plainText.match(new RegExp(word, "g")) ?? []).length).toBe(1);
    }
  });
});
