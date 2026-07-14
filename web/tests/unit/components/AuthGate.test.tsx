// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const authState = vi.hoisted(() => ({
  currentUserId: "user-1",
  isAnonymous: false,
  sessionUserIdHint: undefined as string | undefined,
  listener: undefined as ((userId: string) => void) | undefined,
  unsubscribe: vi.fn(),
  fetchSponsorsRemote: vi.fn<() => Promise<{ sponsors: Array<{ name: string; url: string | null }>; disabled: boolean }>>(),
  fetchInstanceBootstrapRemote: vi.fn(),
  fetchAccountLanguageStateRemote: vi.fn(),
  saveAccountLanguagePreferenceRemote: vi.fn(),
  initializeInstanceRemote: vi.fn(),
  signInWithPasswordRemote: vi.fn(),
  restoreAuthSessionRemote: vi.fn<() => Promise<string>>(),
  requestPasswordResetRemote: vi.fn<(email: string) => Promise<void>>(),
  resetPasswordRemote: vi.fn<(token: string, password: string) => Promise<void>>(),
  verifyAccountEmailRemote: vi.fn<(token: string) => Promise<void>>(),
  verifyEmailChangeRemote: vi.fn<(token: string) => Promise<void>>(),
  verifyMagicLinkRemote: vi.fn<(token: string) => Promise<string>>(),
}));

vi.mock("@/lib/edgebase", () => ({
  anonymousBootstrapAvailableRemote: vi.fn(async () => false),
  changePasswordRemote: vi.fn(async () => undefined),
  clearMustChangePasswordRemote: vi.fn(async () => undefined),
  completeOAuthCallbackRemote: vi.fn(async () => ""),
  currentSessionUserIdHint: vi.fn(() => authState.sessionUserIdHint ?? authState.currentUserId),
  currentUserId: vi.fn(() => authState.currentUserId),
  currentUserIsAnonymous: vi.fn(() => authState.isAnonymous),
  fetchAccountLanguageStateRemote: authState.fetchAccountLanguageStateRemote,
  fetchInstanceBootstrapRemote: authState.fetchInstanceBootstrapRemote,
  fetchMustChangePasswordRemote: vi.fn(async () => false),
  fetchSponsorsRemote: authState.fetchSponsorsRemote,
  fetchRuntimeConfigRemote: vi.fn(async () => ({
    allowAnonymousBootstrap: false,
    oauthProviders: [],
    notionOAuthConfigured: false,
    legal: {
      sourceUrl: "https://example.com/source",
      agplLicenseUrl: "https://example.com/agpl",
      sponsorExceptionUrl: "https://example.com/exception",
    },
  })),
  initializeInstanceRemote: authState.initializeInstanceRemote,
  oauthProviderOptions: vi.fn((providers: string[]) =>
    providers.map((provider) => ({ provider, label: provider }))),
  DEFAULT_LEGAL_LINKS: {
    sourceUrl: "https://example.com/source",
    agplLicenseUrl: "https://example.com/agpl",
    sponsorExceptionUrl: "https://example.com/exception",
  },
  recordAuthAttemptRemote: vi.fn(async () => undefined),
  requestPasswordResetRemote: authState.requestPasswordResetRemote,
  resetPasswordRemote: authState.resetPasswordRemote,
  restoreAuthSessionRemote: authState.restoreAuthSessionRemote,
  saveAccountLanguagePreferenceRemote: authState.saveAccountLanguagePreferenceRemote,
  signInWithPasswordRemote: authState.signInWithPasswordRemote,
  signUpWithPasswordRemote: vi.fn(),
  signInAnonymouslyForBootstrap: vi.fn(),
  startOAuthSignInRemote: vi.fn(),
  subscribeAuthStateRemote: vi.fn((listener: (userId: string) => void) => {
    authState.listener = listener;
    listener(authState.currentUserId);
    return authState.unsubscribe;
  }),
  verifyAccountEmailRemote: authState.verifyAccountEmailRemote,
  verifyEmailChangeRemote: authState.verifyEmailChangeRemote,
  verifyMagicLinkRemote: authState.verifyMagicLinkRemote,
  verifyMfaRecoveryRemote: vi.fn(),
  verifyMfaTotpRemote: vi.fn(),
}));

import { AuthGate, authErrorMessage } from "@/components/AuthGate";
import { i18next } from "@/i18n";
import { fetchRuntimeConfigRemote, subscribeAuthStateRemote } from "@/lib/edgebase";

const subscribeAuthStateRemoteMock = vi.mocked(subscribeAuthStateRemote);
const fetchRuntimeConfigRemoteMock = vi.mocked(fetchRuntimeConfigRemote);

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
  authState.currentUserId = "user-1";
  authState.isAnonymous = false;
  authState.sessionUserIdHint = undefined;
  authState.listener = undefined;
  authState.unsubscribe.mockReset();
  authState.fetchSponsorsRemote.mockReset();
  authState.fetchSponsorsRemote.mockResolvedValue({ sponsors: [], disabled: false });
  authState.fetchInstanceBootstrapRemote.mockReset();
  authState.fetchInstanceBootstrapRemote.mockResolvedValue(null);
  authState.fetchAccountLanguageStateRemote.mockReset();
  authState.fetchAccountLanguageStateRemote.mockResolvedValue({
    languagePreference: "en",
    languageOnboardingCompleted: true,
  });
  authState.saveAccountLanguagePreferenceRemote.mockReset();
  authState.saveAccountLanguagePreferenceRemote.mockResolvedValue({
    languagePreference: "en",
    languageOnboardingCompleted: true,
  });
  window.localStorage.setItem("hanji:language:user-1", "en");
  window.localStorage.setItem("hanji:language:cached-user", "en");
  authState.initializeInstanceRemote.mockReset();
  authState.initializeInstanceRemote.mockResolvedValue(undefined);
  authState.signInWithPasswordRemote.mockReset();
  authState.signInWithPasswordRemote.mockResolvedValue({ status: "signed_in", userId: "setup-master" });
  authState.restoreAuthSessionRemote.mockReset();
  authState.restoreAuthSessionRemote.mockImplementation(async () => authState.currentUserId);
  authState.requestPasswordResetRemote.mockReset();
  authState.requestPasswordResetRemote.mockResolvedValue(undefined);
  authState.resetPasswordRemote.mockReset();
  authState.resetPasswordRemote.mockResolvedValue(undefined);
  authState.verifyAccountEmailRemote.mockReset();
  authState.verifyAccountEmailRemote.mockResolvedValue(undefined);
  authState.verifyEmailChangeRemote.mockReset();
  authState.verifyEmailChangeRemote.mockResolvedValue(undefined);
  authState.verifyMagicLinkRemote.mockReset();
  authState.verifyMagicLinkRemote.mockImplementation(async () => {
    authState.currentUserId = "magic-user";
    return "magic-user";
  });
  fetchRuntimeConfigRemoteMock.mockResolvedValue({
    allowAnonymousBootstrap: false,
    oauthProviders: [],
    notionOAuthConfigured: false,
    legal: {
      sourceUrl: "https://example.com/source",
      agplLicenseUrl: "https://example.com/agpl",
      sponsorExceptionUrl: "https://example.com/exception",
    },
  });
  subscribeAuthStateRemoteMock.mockClear();
});

afterEach(cleanup);

describe("AuthGate auth-state subscription", () => {
  it("asks an authenticated unconfigured account once and recommends the browser language first", async () => {
    window.localStorage.removeItem("hanji:language:user-1");
    authState.fetchAccountLanguageStateRemote.mockResolvedValue({
      languagePreference: null,
      languageOnboardingCompleted: false,
    });

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByTestId("language-onboarding")).toBeTruthy();
    expect(screen.queryByTestId("private-workspace")).toBeNull();
    const selector = screen.getByLabelText("Language") as HTMLSelectElement;
    expect(selector.value).toBe("en");
    expect(selector.options[0]?.value).toBe("en");
    expect(selector.options[0]?.textContent).toContain("Recommended");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(authState.saveAccountLanguagePreferenceRemote).toHaveBeenCalledWith("en");
      expect(screen.getByTestId("private-workspace")).toBeTruthy();
    });
    expect(window.localStorage.getItem("hanji:language:user-1")).toBe("en");
  });

  it("does not show language onboarding to anonymous authenticated sessions", async () => {
    authState.isAnonymous = true;
    window.localStorage.clear();

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByTestId("private-workspace")).toBeTruthy();
    expect(screen.queryByTestId("language-onboarding")).toBeNull();
    expect(authState.fetchAccountLanguageStateRemote).not.toHaveBeenCalled();
  });

  it("does not show or fetch account language onboarding on a public share", async () => {
    window.history.replaceState(null, "", "/share/public-token");
    authState.currentUserId = "";
    window.localStorage.clear();

    render(
      <AuthGate>
        <div data-testid="public-share">Public share</div>
      </AuthGate>,
    );

    expect(screen.getByTestId("public-share")).toBeTruthy();
    expect(screen.queryByTestId("language-onboarding")).toBeNull();
    expect(authState.fetchAccountLanguageStateRemote).not.toHaveBeenCalled();
  });

  it("offers browser-only first-run administrator creation", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");
    authState.fetchInstanceBootstrapRemote.mockResolvedValue({
      masterConfigured: false,
      masterReady: false,
      setupBlocked: false,
      setupAvailable: true,
      setupInProgress: false,
    });

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByTestId("instance-setup")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
    expect(screen.queryByLabelText("Setup code")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Owner" } });
    fireEvent.change(screen.getByLabelText("Administrator email"), {
      target: { value: "Owner@Example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Hanji-Owner!2026" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "Hanji-Owner!2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create administrator and continue" }));

    await screen.findByTestId("private-workspace");
    expect(authState.initializeInstanceRemote).toHaveBeenCalledWith({
      email: "owner@example.com",
      password: "Hanji-Owner!2026",
      displayName: "Owner",
    }, undefined);
    expect(authState.signInWithPasswordRemote).toHaveBeenCalledWith(
      "owner@example.com",
      "Hanji-Owner!2026",
    );
  });

  it("consumes a private hosted setup fragment without retaining it in browser history", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");
    window.history.replaceState(null, "", "/#setup_token=private-hosted-token&state=keep");
    authState.fetchInstanceBootstrapRemote.mockImplementation(async (setupToken?: string) => ({
      masterConfigured: false,
      masterReady: false,
      setupBlocked: false,
      setupAvailable: setupToken === "private-hosted-token",
      setupAuthorizationRequired: setupToken !== "private-hosted-token",
      setupInProgress: false,
    }));

    render(<AuthGate><div data-testid="private-workspace">Private workspace</div></AuthGate>);

    expect(await screen.findByTestId("instance-setup")).toBeTruthy();
    expect(window.location.hash).toBe("#state=keep");
    expect(authState.fetchInstanceBootstrapRemote).toHaveBeenCalledWith("private-hosted-token");

    fireEvent.change(screen.getByLabelText("Administrator email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Hanji-Owner!2026" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "Hanji-Owner!2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create administrator and continue" }));

    await screen.findByTestId("private-workspace");
    expect(authState.initializeInstanceRemote).toHaveBeenCalledWith({
      email: "owner@example.com",
      password: "Hanji-Owner!2026",
      displayName: undefined,
    }, "private-hosted-token");
    expect(window.sessionStorage.getItem("hanji:setup:token")).toBeNull();
  });

  it("discards the hosted setup capability once creation succeeds even when sign-in fails", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");
    authState.signInWithPasswordRemote.mockRejectedValue(new Error("temporary sign-in failure"));
    window.history.replaceState(null, "", "/#setup_token=private-hosted-token");
    authState.fetchInstanceBootstrapRemote.mockImplementation(async (setupToken?: string) => ({
      masterConfigured: false,
      masterReady: false,
      setupBlocked: false,
      setupAvailable: setupToken === "private-hosted-token",
      setupAuthorizationRequired: setupToken !== "private-hosted-token",
      setupInProgress: false,
    }));

    render(<AuthGate><div>Private workspace</div></AuthGate>);
    await screen.findByTestId("instance-setup");
    fireEvent.change(screen.getByLabelText("Administrator email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Hanji-Owner!2026" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "Hanji-Owner!2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create administrator and continue" }));

    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("already been set up");
    expect(window.sessionStorage.getItem("hanji:setup:token")).toBeNull();
    expect(authState.initializeInstanceRemote).toHaveBeenCalledTimes(1);
  });

  it("keeps first-run setup on screen when password confirmation differs", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");
    authState.fetchInstanceBootstrapRemote.mockResolvedValue({
      masterConfigured: false,
      masterReady: false,
      setupBlocked: false,
      setupAvailable: true,
      setupInProgress: false,
    });
    render(<AuthGate><div>Private workspace</div></AuthGate>);
    await screen.findByTestId("instance-setup");
    fireEvent.change(screen.getByLabelText("Administrator email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Hanji-Owner!2026" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "Different!2026a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create administrator and continue" }));

    expect(await screen.findByText("The new passwords do not match.")).toBeTruthy();
    expect(authState.initializeInstanceRemote).not.toHaveBeenCalled();
  });

  it("directs closed-signup users to server account provisioning, not invitations", () => {
    const message = authErrorMessage({
      slug: "hook_rejected",
      message: "Signup is restricted by server policy.",
    });

    expect(message).toContain("create your server account");
    expect(message).not.toMatch(/invit/i);
  });

  it("describes the password requirements before account creation", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");

    render(
      <AuthGate>
        <div>Private workspace</div>
      </AuthGate>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Create account" }));
    const password = screen.getByLabelText("Password");
    const help = screen.getByText(/Use 10 or more characters/i);
    expect(password.getAttribute("aria-describedby")).toBe(help.id);
    expect(screen.getByRole("button", { name: "Sign in instead" })).toBeTruthy();
  });

  it("renders social sign-in buttons from the backend runtime capability", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");
    fetchRuntimeConfigRemoteMock.mockResolvedValue({
      allowAnonymousBootstrap: false,
      oauthProviders: ["x"],
      notionOAuthConfigured: false,
      legal: {
        sourceUrl: "https://example.com/source",
        agplLicenseUrl: "https://example.com/agpl",
        sponsorExceptionUrl: "https://example.com/exception",
      },
    });

    render(
      <AuthGate>
        <div>Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByRole("button", { name: "Continue with x" })).toBeTruthy();
  });

  it("thanks a sponsor from the feed with a linked name and no hide control", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");
    authState.fetchSponsorsRemote.mockResolvedValue({
      sponsors: [{ name: "Example sponsor", url: "https://github.com/example-sponsor" }],
      disabled: false,
    });

    render(
      <AuthGate>
        <div>Private workspace</div>
      </AuthGate>,
    );

    const link = await screen.findByRole("link", { name: "Example sponsor" });
    const banner = screen.getByTestId("sponsor-banner");
    expect(banner.textContent).toContain("Example sponsor");
    // The sponsor name is the only linked part, pointing at their GitHub.
    expect(link.getAttribute("href")).toBe("https://github.com/example-sponsor");
    // The banner no longer carries a per-user hide control.
    expect(screen.queryByRole("button", { name: "Hide sponsor banner" })).toBeNull();
  });

  it("falls back to a built-with credit when the feed has no sponsors", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");
    authState.fetchSponsorsRemote.mockResolvedValue({ sponsors: [], disabled: false });

    render(
      <AuthGate>
        <div>Private workspace</div>
      </AuthGate>,
    );

    const banner = await screen.findByTestId("sponsor-banner");
    // With no sponsors the banner shows a built-with credit rather than nothing.
    expect(banner.textContent).toMatch(/Cloudflare|Claude|ChatGPT|GLM|GitHub/);
    expect(banner.textContent).toContain("build Hanji");
    expect(screen.getByTestId("legal-notice")).toBeTruthy();
  });

  it("hides the banner entirely when the operator disabled the feature", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");
    authState.fetchSponsorsRemote.mockResolvedValue({ sponsors: [], disabled: true });

    render(
      <AuthGate>
        <div>Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByLabelText(/Email|이메일/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("sponsor-banner")).toBeNull());
    // The required AGPL / Sponsor Banner Exception notice always stays on the
    // sign-in screen regardless of the banner mode.
    expect(screen.getByTestId("legal-notice")).toBeTruthy();
  });

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

  it("ignores repeated positive events for the already-validated user", async () => {
    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByTestId("private-workspace")).toBeTruthy();
    expect(authState.restoreAuthSessionRemote).toHaveBeenCalledOnce();

    await act(async () => {
      authState.listener?.("user-1");
      authState.listener?.("user-1");
    });

    expect(authState.restoreAuthSessionRemote).toHaveBeenCalledOnce();
    expect(screen.getByTestId("private-workspace")).toBeTruthy();
    expect(screen.queryByText(/Finishing sign-in|로그인 마무리 중/)).toBeNull();
  });

  it("renders a cached workspace immediately, then removes it on definitive auth denial", async () => {
    authState.currentUserId = "cached-user";
    await i18next.changeLanguage("ko");
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
    expect(screen.getByTestId("private-workspace")).toBeTruthy();
    expect(screen.queryByTestId("product-loading-screen")).toBeNull();
    expect(screen.queryByLabelText(/Email|이메일/)).toBeNull();

    await act(async () => {
      authState.currentUserId = "";
      authState.sessionUserIdHint = "";
      finishRestore("");
    });
    expect(screen.queryByTestId("private-workspace")).toBeNull();
    expect(screen.getByLabelText(/Email|이메일/)).toBeTruthy();
    await waitFor(() => expect(i18next.resolvedLanguage).toBe("en"));
  });

  it("keeps the cached workspace on a transient refresh failure while the hint remains", async () => {
    authState.currentUserId = "";
    authState.sessionUserIdHint = "cached-user";
    authState.restoreAuthSessionRemote.mockRejectedValue(new TypeError("network unavailable"));

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(screen.getByTestId("private-workspace")).toBeTruthy();
    await act(async () => {});
    expect(screen.getByTestId("private-workspace")).toBeTruthy();
    expect(screen.queryByLabelText(/Email|이메일/)).toBeNull();

    await act(async () => {
      authState.listener?.("cached-user");
    });
    expect(screen.getByTestId("private-workspace")).toBeTruthy();
    expect(screen.queryByTestId("product-loading-screen")).toBeNull();
  });

  it("uses the non-authoritative cookie-session hint before currentUser is online-verified", async () => {
    authState.currentUserId = "";
    authState.sessionUserIdHint = "cached-user";
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

    expect(screen.getByTestId("private-workspace")).toBeTruthy();
    expect(screen.queryByTestId("product-loading-screen")).toBeNull();

    await act(async () => {
      finishRestore("cached-user");
    });
    expect(screen.getByTestId("private-workspace")).toBeTruthy();
  });

  it("keeps first-visit auth checking to only the mark and one random credit", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockImplementation(() => new Promise<string>(() => {}));

    render(
      <AuthGate>
        <div data-testid="private-workspace">Private workspace</div>
      </AuthGate>,
    );

    expect(screen.getByTestId("product-loading-screen")).toBeTruthy();
    expect(screen.getByTestId("product-loading-mark")).toBeTruthy();
    expect(screen.getByTestId("product-loading-credit")).toBeTruthy();
    expect(screen.queryByText(/Finishing sign-in|로그인 마무리 중/)).toBeNull();
    expect(screen.queryByText(/Checking your login session|로그인 세션을 확인/)).toBeNull();
    expect(screen.queryByTestId("legal-notice")).toBeNull();
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

  it("requests a password-reset link without revealing whether the account exists", async () => {
    authState.currentUserId = "";
    authState.restoreAuthSessionRemote.mockResolvedValue("");

    render(
      <AuthGate>
        <div>Private workspace</div>
      </AuthGate>,
    );

    await screen.findByRole("button", { name: "Forgot password?" });
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "reset-user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText(/If an account exists for this email/)).toBeTruthy();
    expect(authState.requestPasswordResetRemote).toHaveBeenCalledWith("reset-user@example.com");
  });

  it("reads a password-reset token from the fragment, scrubs it, and completes the route", async () => {
    window.history.replaceState(
      null,
      "",
      "/auth/reset-password?keep=query#token=reset-secret&state=keep-fragment",
    );

    render(
      <AuthGate>
        <div>Private workspace</div>
      </AuthGate>,
    );

    const nextPassword = "NewSecure!2026";
    fireEvent.change(await screen.findByLabelText("New password"), {
      target: { value: nextPassword },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: nextPassword },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByText(/Your password has been reset/)).toBeTruthy();
    expect(authState.resetPasswordRemote).toHaveBeenCalledWith("reset-secret", nextPassword);
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`)
      .toBe("/auth/reset-password?keep=query#state=keep-fragment");
  });

  it("verifies account and email-change links from fragments without retaining bearer tokens", async () => {
    window.history.replaceState(null, "", "/auth/verify-email#token=verify-secret&state=keep");
    const first = render(
      <AuthGate>
        <div>Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByText("Your email address has been verified.")).toBeTruthy();
    expect(authState.verifyAccountEmailRemote).toHaveBeenCalledWith("verify-secret");
    expect(window.location.hash).toBe("#state=keep");

    first.unmount();
    window.history.replaceState(null, "", "/auth/verify-email-change#token=change-secret");
    render(
      <AuthGate>
        <div>Private workspace</div>
      </AuthGate>,
    );

    expect(await screen.findByText("Your new email address has been confirmed.")).toBeTruthy();
    expect(authState.verifyEmailChangeRemote).toHaveBeenCalledWith("change-secret");
    expect(window.location.hash).toBe("");
  });
});
