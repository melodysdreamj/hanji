import { describe, expect, it } from "vitest";
import { clampedPopoverLeft, clampedPopoverWidth } from "@/lib/popoverGeometry";

describe("popover viewport geometry", () => {
  it("shrinks a 340px menu into a 320px viewport without a negative left edge", () => {
    const width = clampedPopoverWidth(340, 320);
    expect(width).toBe(304);
    expect(clampedPopoverLeft(200, width, 320)).toBe(8);
    expect(clampedPopoverLeft(-20, width, 320)).toBe(8);
  });
});
