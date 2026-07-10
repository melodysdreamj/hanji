// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const authState = vi.hoisted(() => ({
  currentUserId: "user-1",
  listener: undefined as ((userId: string) => void) | undefined,
  unsubscribe: vi.fn(),
  restoreAuthSessionRemote: vi.fn<() => Promise<string>>(),
  verifyMagicLinkRemote: vi.fn<(token: string) => Promise<string>>(),
}));

vi.mock("@/lib/edgebase", () => ({
  anonymousBootstrapAvailableRemote: vi.fn(async () => false),
  completeOAuthCallbackRemote: vi.fn(async () => ""),
  configuredOAuthProviders: vi.fn(() => []),
  currentUserId: vi.fn(() => authState.currentUserId),
  recordAuthAttemptRemote: vi.fn(async () => undefined),
  restoreAuthSessionRemote: authState.restoreAuthSessionRemote,
  signInWithPasswordRemote: vi.fn(),
  signUpWithPasswordRemote: vi.fn(),
  signInAnonymouslyForBootstrap: vi.fn(),
  startOAuthSignInRemote: vi.fn(),
  subscribeAuthStateRemote: vi.fn((listener: (userId: string) => void) => {
    authState.listener = listener;
    listener(authState.currentUserId);
    return authState.unsubscribe;
  }),
  verifyMagicLinkRemote: authState.verifyMagicLinkRemote,
  verifyMfaRecoveryRemote: vi.fn(),
  verifyMfaTotpRemote: vi.fn(),
}));

import { AuthGate } from "@/components/AuthGate";
import { subscribeAuthStateRemote } from "@/lib/edgebase";

const subscribeAuthStateRemoteMock = vi.mocked(subscribeAuthStateRemote);

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  authState.currentUserId = "user-1";
  authState.listener = undefined;
  authState.unsubscribe.mockReset();
  authState.restoreAuthSessionRemote.mockReset();
  authState.restoreAuthSessionRemote.mockImplementation(async () => authState.currentUserId);
  authState.verifyMagicLinkRemote.mockReset();
  authState.verifyMagicLinkRemote.mockResolvedValue("magic-user");
  subscribeAuthStateRemoteMock.mockClear();
});

afterEach(cleanup);

describe("AuthGate auth-state subscription", () => {
  it("reacts to sign-out and sign-in events and unsubscribes on unmount", async () => {
    const rendered = render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByTestId("private-workspace")).toBeTruthy();
    expect(subscribeAuthStateRemoteMock).toHaveBeenCalledTimes(1);
    expect(authState.listener).toBeTypeOf("function");

    await act(async () => {
      authState.currentUserId = "";
      authState.listener?.("");
    });

    expect(screen.queryByTestId("private-workspace")).toBeNull();
    expect(screen.getByLabelText(/Email|이메일/)).toBeTruthy();

    await act(async () => {
      authState.currentUserId = "user-2";
      authState.listener?.("user-2");
    });

    expect(screen.getByTestId("private-workspace")).toBeTruthy();

    rendered.unmount();
    expect(authState.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("restores a cookie-only session before showing the sign-in form", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("cookie-user");

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(screen.queryByLabelText(/Email|이메일/)).toBeNull();
    expect(await screen.findByTestId("private-workspace")).toBeTruthy();
    expect(authState.restoreAuthSessionRemote).toHaveBeenCalledOnce();
  });

  it("does not render private children from an unverified cached marker", async () => {
    authState.currentUserId = "cached-user";
    let finishRestore!: (userId: string) => void;
    authState.restoreAuthSessionRemote.mockImplementation(() =>
      new Promise<string>((resolve) => {
        finishRestore = resolve;
      })
    );

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );
    expect(screen.queryByTestId("private-workspace")).toBeNull();
    expect(screen.queryByLabelText(/Email|이메일/)).toBeNull();

    await act(async () => {
      finishRestore("");
    });
    expect(screen.queryByTestId("private-workspace")).toBeNull();
    expect(screen.getByLabelText(/Email|이메일/)).toBeTruthy();
  });

  it("revalidates a positive cross-tab marker after the sign-in form is visible", async () => {
    authState.currentUserId = "";
    let finishCrossTabRestore!: (userId: string) => void;
    authState.restoreAuthSessionRemote
      .mockResolvedValueOnce("")
      .mockImplementationOnce(() =>
        new Promise<string>((resolve) => {
          finishCrossTabRestore = resolve;
        })
      );

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );
    expect(await screen.findByLabelText(/Email|이메일/)).toBeTruthy();

    await act(async () => {
      authState.currentUserId = "unverified-cross-tab-user";
      authState.listener?.("unverified-cross-tab-user");
    });

    expect(screen.queryByTestId("private-workspace")).toBeNull();
    expect(screen.queryByLabelText(/Email|이메일/)).toBeNull();
    await act(async () => {
      authState.listener?.("unverified-cross-tab-user");
    });
    expect(authState.restoreAuthSessionRemote).toHaveBeenCalledTimes(2);

    await act(async () => {
      finishCrossTabRestore("");
    });
    expect(screen.queryByTestId("private-workspace")).toBeNull();
    expect(screen.getByLabelText(/Email|이메일/)).toBeTruthy();
  });

  it("does not let a stale positive revalidation win after sign-out", async () => {
    authState.currentUserId = "";
    let finishCrossTabRestore!: (userId: string) => void;
    authState.restoreAuthSessionRemote
      .mockResolvedValueOnce("")
      .mockImplementationOnce(() =>
        new Promise<string>((resolve) => {
          finishCrossTabRestore = resolve;
        })
      );

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );
    expect(await screen.findByLabelText(/Email|이메일/)).toBeTruthy();

    await act(async () => {
      authState.listener?.("cross-tab-user");
      authState.listener?.("");
    });
    await act(async () => {
      finishCrossTabRestore("stale-cross-tab-user");
    });

    expect(screen.queryByTestId("private-workspace")).toBeNull();
    expect(screen.getByLabelText(/Email|이메일/)).toBeTruthy();
  });

  it("accepts an EdgeBase magic-link token from the URL fragment", async () => {
    authState.currentUserId = "";
    window.history.replaceState(null, "", "/auth/magic-link#token=fragment-token");

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByTestId("private-workspace")).toBeTruthy();
    expect(authState.verifyMagicLinkRemote).toHaveBeenCalledWith("fragment-token");
  });

  it("scrubs a magic-link token before a failed verification while preserving URL state", async () => {
    authState.currentUserId = "";
    authState.verifyMagicLinkRemote.mockRejectedValue(new Error("expired link"));
    window.history.replaceState(
      null,
      "",
      "/auth/magic-link?keep=query&token=query-secret#state=keep-fragment",
    );

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByLabelText(/Email|이메일/)).toBeTruthy();
    expect(authState.verifyMagicLinkRemote).toHaveBeenCalledWith("query-secret");
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`)
      .toBe("/auth/magic-link?keep=query#state=keep-fragment");
  });
});
