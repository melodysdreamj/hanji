import { describe, expect, it } from "vitest";
import { sharedPageErrorKind } from "@/lib/sharedPageErrors";

describe("shared-page error classification", () => {
  it.each([
    [Object.assign(new Error("raw storage detail"), { code: 404 }), "not-found"],
    [Object.assign(new Error("raw storage detail"), { status: 403 }), "not-found"],
    [Object.assign(new Error("raw storage detail"), { slug: "share-token-expired" }), "not-found"],
    [Object.assign(new Error("raw storage detail"), { code: 429 }), "rate-limited"],
    [new TypeError("Failed to fetch"), "offline"],
    [new Error("database shard public_pages_internal failed"), "unavailable"],
  ])("maps failures to safe user-facing categories", (error, expected) => {
    expect(sharedPageErrorKind(error)).toBe(expected);
  });
});
