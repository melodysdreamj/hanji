// @vitest-environment jsdom
//
// H1 regression guard (base safety): the reserved base clientID must only ever
// carry content we can prove is the shared origin. A session that seeds grown,
// possibly-shared content with NO durable state to hydrate from (a block past
// the old 120-block prime cap, or edited before the resync ran) is NOT
// base-safe: emitting it would re-encode a peer's already-merged characters as
// base items and duplicate them on merge. Such an emit must be DEFERRED
// (undefined) until the block is primed — either its durable state arrives, or
// the server confirms it has no durable document (never collaborated → pristine
// → safe to seed).
import { describe, expect, it } from "vitest";
import {
  createBlockTextCrdtUpdateFromUndoSession,
  markBlockTextCollaborationPristine,
  rememberBlockTextDurableState,
  __buildBlockTextClientUpdateForTest as buildClientUpdate,
} from "@/lib/collaborationCrdt";
import type { TextSpan } from "@/lib/types";

const plain = (text: string): TextSpan[] => [{ text }];

describe("CRDT block-text base safety (H1 beyond the prime cap)", () => {
  it("defers the emit for grown content with no durable state and no priming", async () => {
    const blockId = "base-safety-ungprimed-grown";
    const update = await createBlockTextCrdtUpdateFromUndoSession({
      blockId,
      rich: plain("hello world"),
      updatedAt: "",
    });
    // Not base-safe: would duplicate a peer's " world" on merge. Deferred.
    expect(update).toBeUndefined();
  });

  it("emits once the block is confirmed pristine (server has no durable doc)", async () => {
    const blockId = "base-safety-pristine";
    markBlockTextCollaborationPristine(blockId);
    const update = await createBlockTextCrdtUpdateFromUndoSession({
      blockId,
      rich: plain("hello world"),
      updatedAt: "",
    });
    expect(update).toBeDefined();
    expect(update?.engine).toBe("yjs");
  });

  it("emits once authoritative durable state is available (hydrated)", async () => {
    const blockId = "base-safety-hydrated";
    // A peer authored " world" on top of "hello"; its durable state is known.
    const peer = await buildClientUpdate(blockId, plain("hello"), plain("hello world"));
    rememberBlockTextDurableState(blockId, peer.updateBase64);
    const update = await createBlockTextCrdtUpdateFromUndoSession({
      blockId,
      rich: plain("hello world!"),
      updatedAt: "",
    });
    expect(update).toBeDefined();
  });

  it("empty content is always base-safe", async () => {
    const blockId = "base-safety-empty";
    const update = await createBlockTextCrdtUpdateFromUndoSession({
      blockId,
      rich: [],
      updatedAt: "",
    });
    expect(update).toBeDefined();
  });
});
