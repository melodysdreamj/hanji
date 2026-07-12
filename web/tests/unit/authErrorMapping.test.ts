// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authErrorMessage } from "@/components/AuthGate";

beforeEach(() => {
  vi.spyOn(window.navigator, "language", "get").mockReturnValue("en-US");
});

describe("auth error mapping", () => {
  it.each([
    [Object.assign(new Error("Authentication verification failed."), { code: 401, slug: "invalid-credentials" }), "The email or password is incorrect."],
    [Object.assign(new Error("raw sdk text"), { code: "invalid_credentials" }), "The email or password is incorrect."],
    [Object.assign(new Error("raw sdk text"), { code: "email_already_exists" }), "An account already exists for this email. Sign in instead."],
    [Object.assign(new Error("raw sdk text"), { code: "too_many_requests" }), "Too many attempts. Wait a moment and try again."],
    [
      Object.assign(new Error("raw sdk text"), { code: 403, slug: "cookie-auth-origin-untrusted" }),
      "The app and authentication server addresses do not match. Reload this tab or check the server's allowed origins.",
    ],
    [
      Object.assign(new Error("Cookie auth requests require an Origin header."), { code: 403, slug: "forbidden" }),
      "The app and authentication server addresses do not match. Reload this tab or check the server's allowed origins.",
    ],
    [
      Object.assign(new Error("raw sdk text"), { code: 403, slug: "account-disabled" }),
      "The server rejected the authentication request. Check the account or server policy and try again.",
    ],
    [new TypeError("Failed to fetch"), "The sign-in service is unavailable. Check your connection and try again."],
  ])("maps structured/common auth failures without leaking raw SDK text", (error, expected) => {
    expect(authErrorMessage(error)).toBe(expected);
  });

  it("uses a safe generic message for unknown backend details", () => {
    expect(authErrorMessage(new Error("database shard auth_users_internal failed"))).toBe("Sign-in failed.");
  });
});
