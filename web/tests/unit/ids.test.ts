import { describe, expect, it } from "vitest";
import { newId, positionBetween } from "@/lib/ids";

describe("newId", () => {
  it("returns a non-empty string", () => {
    const id = newId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns unique values across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()));
    expect(ids.size).toBe(100);
  });

  it("returns a UUID when crypto.randomUUID is available", () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});

describe("positionBetween", () => {
  it("returns 1 for the first item", () => {
    expect(positionBetween(undefined, undefined)).toBe(1);
  });

  it("appends after the last item", () => {
    expect(positionBetween(5, undefined)).toBe(6);
    expect(positionBetween(0, undefined)).toBe(1);
    expect(positionBetween(-2, undefined)).toBe(-1);
  });

  it("prepends before the first item", () => {
    expect(positionBetween(undefined, 4)).toBe(2);
    expect(positionBetween(undefined, 1)).toBe(0.5);
  });

  it("returns the midpoint between two siblings", () => {
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(positionBetween(-4, 4)).toBe(0);
  });

  it("treats null like undefined (== null check)", () => {
    expect(
      positionBetween(null as unknown as undefined, null as unknown as undefined)
    ).toBe(1);
  });
});
