import { describe, expect, it } from "vitest";
import { BUILT_WITH, SPONSOR_SLOTS, builtWithRoll, creditRoll, loginRoll, sponsorRoll } from "@/lib/builtWith";

describe("sponsorRoll", () => {
  it("keeps only sponsors, capped at five", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `S${i}`, url: null }));
    const slots = sponsorRoll(many);
    expect(slots).toHaveLength(SPONSOR_SLOTS);
    expect(slots.every((slot) => slot.kind === "sponsor")).toBe(true);
  });

  it("is empty with no sponsors — the license banner then shows nothing", () => {
    expect(sponsorRoll([])).toEqual([]);
  });
});

describe("creditRoll", () => {
  it("fills empty slots with built-with credits so there are always five", () => {
    const slots = creditRoll([]);
    expect(slots).toHaveLength(SPONSOR_SLOTS);
    expect(slots.every((slot) => slot.kind === "builtWith")).toBe(true);
    expect(slots.map((slot) => slot.name)).toEqual(BUILT_WITH.map((entry) => entry.name));
  });

  it("puts real sponsors first, then fills the remaining slots", () => {
    const slots = creditRoll([
      { name: "Ada", url: "https://github.com/ada" },
      { name: "Bo", url: null },
    ]);
    expect(slots).toHaveLength(SPONSOR_SLOTS);
    expect(slots[0]).toEqual({ kind: "sponsor", name: "Ada", url: "https://github.com/ada" });
    expect(slots[1]).toEqual({ kind: "sponsor", name: "Bo", url: null });
    expect(slots.slice(2).every((slot) => slot.kind === "builtWith")).toBe(true);
  });

  it("shows only sponsors once five or more are present", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, url: null }));
    const slots = creditRoll(five);
    expect(slots).toHaveLength(SPONSOR_SLOTS);
    expect(slots.every((slot) => slot.kind === "sponsor")).toBe(true);
  });
});

describe("builtWithRoll", () => {
  it("returns every built-with credit as a slot", () => {
    const slots = builtWithRoll();
    expect(slots.map((slot) => slot.name)).toEqual(BUILT_WITH.map((entry) => entry.name));
    expect(slots.every((slot) => slot.kind === "builtWith")).toBe(true);
  });
});

describe("loginRoll", () => {
  it("shows sponsors when the feed has any (so the license surface surfaces them)", () => {
    const slots = loginRoll([{ name: "Ada", url: "https://github.com/ada" }]);
    expect(slots).toEqual([{ kind: "sponsor", name: "Ada", url: "https://github.com/ada" }]);
  });

  it("falls back to built-with credits when there are no sponsors", () => {
    const slots = loginRoll([]);
    expect(slots.map((slot) => slot.name)).toEqual(BUILT_WITH.map((entry) => entry.name));
    expect(slots.every((slot) => slot.kind === "builtWith")).toBe(true);
  });

  it("does not fill with built-with when sponsors exist", () => {
    const slots = loginRoll([
      { name: "Ada", url: null },
      { name: "Bo", url: null },
    ]);
    expect(slots).toHaveLength(2);
    expect(slots.every((slot) => slot.kind === "sponsor")).toBe(true);
  });
});
