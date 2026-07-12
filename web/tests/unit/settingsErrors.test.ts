import { describe, expect, it } from "vitest";
import {
  isRateLimitError,
  settingsErrorMessage,
  shouldSuppressBackgroundSettingsError,
} from "@/lib/settingsErrors";

describe("settings error helpers", () => {
  it("recognizes rate-limit errors by status, code, and message", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ code: 429 })).toBe(true);
    expect(isRateLimitError(new Error("Too many requests. Please try again later."))).toBe(true);
    expect(isRateLimitError(new Error("Workspace access required."))).toBe(false);
  });

  it("does not leak raw rate-limit copy into Settings notices", () => {
    expect(settingsErrorMessage(new Error("Too many requests. Please try again later."), "fallback")).toBe(
      "Too many requests right now. Please try again in a moment.",
    );
    expect(settingsErrorMessage(new Error("Workspace access required."), "fallback")).toBe(
      "Workspace access required.",
    );
    expect(settingsErrorMessage({}, "fallback")).toBe("fallback");
  });

  it("suppresses background rate-limit noise when Settings already has visible fallback data", () => {
    expect(shouldSuppressBackgroundSettingsError({ status: 429 }, true)).toBe(true);
    expect(shouldSuppressBackgroundSettingsError({ status: 429 }, false)).toBe(false);
    expect(shouldSuppressBackgroundSettingsError(new Error("Workspace access required."), true)).toBe(false);
  });
});
