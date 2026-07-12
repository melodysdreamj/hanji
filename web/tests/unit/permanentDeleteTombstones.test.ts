// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  permanentDeleteIds,
  rememberPermanentDeleteIds,
  resetPermanentDeleteTombstonesForTests,
} from "@/lib/permanentDeleteTombstones";

beforeEach(() => {
  window.localStorage.clear();
  resetPermanentDeleteTombstonesForTests();
});

describe("permanent-delete tombstones", () => {
  it("persists server-confirmed ids synchronously across a fresh module memory view", () => {
    rememberPermanentDeleteIds("user-a", ["page-a", "row-b"]);
    resetPermanentDeleteTombstonesForTests();

    expect([...permanentDeleteIds("user-a")]).toEqual(["page-a", "row-b"]);
    expect([...permanentDeleteIds("user-b")]).toEqual([]);
  });

  it("deduplicates ids while preserving the newest bounded order", () => {
    rememberPermanentDeleteIds("user-a", ["page-a", "page-b"]);
    rememberPermanentDeleteIds("user-a", ["page-a", "page-c"]);

    expect([...permanentDeleteIds("user-a")]).toEqual(["page-b", "page-a", "page-c"]);
  });
});
