"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  anonymousBootstrapAvailableRemote,
  changePasswordRemote,
  clearMustChangePasswordRemote,
  completeOAuthCallbackRemote,
  currentUserId,
  fetchInstanceBootstrapRemote,
  fetchMustChangePasswordRemote,
  fetchRuntimeConfigRemote,
  oauthProviderOptions,
  recordAuthAttemptRemote,
  requestPasswordResetRemote,
  resetPasswordRemote,
  restoreAuthSessionRemote,
  signInWithPasswordRemote,
  signUpWithPasswordRemote,
  signInAnonymouslyForBootstrap,
  startOAuthSignInRemote,
  subscribeAuthStateRemote,
  verifyAccountEmailRemote,
  verifyEmailChangeRemote,
  verifyMagicLinkRemote,
  verifyMfaRecoveryRemote,
  verifyMfaTotpRemote,
} from "@/lib/edgebase";
import { useTranslation } from "react-i18next";
import { usePathname, useRouter } from "@/lib/router";
import { i18next } from "@/i18n";
import { loginRoll } from "@/lib/builtWith";
import { useCreditRoll } from "@/lib/useCreditRoll";
import { CreditLine } from "./CreditLine";
import { LegalNotice } from "./LegalNotice";
import styles from "./AuthGate.module.css";

type AuthStep =
  | "checking"
  | "email"
  | "magic"
  | "mfa"
  | "password-reset-request"
  | "password-reset"
  | "auth-action-result"
  | "signed-in"
  | "setup-blocked";

function SponsorBanner() {
  // The sign-in banner is the license-protected surface. It shows one entry,
  // chosen at random when the screen loads: a sponsor whenever the feed/snapshot
  // has any (so sponsors are always surfaced), otherwise a built-with credit so
  // it is never empty. It renders nothing only when the operator turned the
  // banner feature off (plain AGPL mode).
  const slot = useCreditRoll({ build: loginRoll });
  if (!slot) return null;
  return (
    <footer className={styles.sponsorBanner} data-testid="sponsor-banner" data-kind={slot.kind}>
      <span className={styles.sponsorLine}>
        <CreditLine slot={slot} />
      </span>
    </footer>
  );
}

type PasswordMode = "signin" | "signup";
type MfaMode = "totp" | "recovery";
type MfaChallenge = {
  ticket: string;
  factors: Array<{ id: string; type: string }>;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Deep-link preservation: sign-in flows that leave the app (OAuth redirect,
// magic-link email) land back on /auth/* routes, losing the page the user
// originally asked for. Stash it before leaving and restore it after auth.
const AUTH_RETURN_PATH_KEY = "hanji:auth:return-to";

function stashAuthReturnPath() {
  if (typeof window === "undefined") return;
  try {
    const { pathname, search, hash } = window.location;
    // Never stash auth routes themselves — that would loop back into the gate.
    if (pathname.startsWith("/auth/")) return;
    const target = `${pathname}${search}${hash}`;
    if (target && target !== "/") {
      window.sessionStorage.setItem(AUTH_RETURN_PATH_KEY, target);
    } else {
      window.sessionStorage.removeItem(AUTH_RETURN_PATH_KEY);
    }
  } catch {
    // Session storage can be unavailable in private browsing or restricted embeds.
  }
}

function consumeAuthReturnPath() {
  if (typeof window === "undefined") return "/";
  try {
    const raw = window.sessionStorage.getItem(AUTH_RETURN_PATH_KEY);
    window.sessionStorage.removeItem(AUTH_RETURN_PATH_KEY);
    if (!raw) return "/";
    // Only same-origin relative paths: must start with a single "/" (reject
    // protocol-relative "//host" and backslash tricks) to avoid open redirects.
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
    if (raw.startsWith("/auth/")) return "/";
    return raw;
  } catch {
    return "/";
  }
}

function authCallbackParam(name: string) {
  if (typeof window === "undefined") return null;
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const fragmentValue = new URLSearchParams(fragment).get(name);
  return fragmentValue ?? new URLSearchParams(window.location.search).get(name);
}

function scrubAuthCallbackParams(...names: string[]) {
  if (typeof window === "undefined" || typeof window.history?.replaceState !== "function") return;
  const url = new URL(window.location.href);
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fragmentParams = new URLSearchParams(fragment);
  const hadFragmentAuthParam = names.some((name) => fragmentParams.has(name));
  let changed = false;
  for (const name of names) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
    if (fragmentParams.has(name)) {
      fragmentParams.delete(name);
      changed = true;
    }
  }
  if (!changed) return;
  if (hadFragmentAuthParam) {
    const nextFragment = fragmentParams.toString();
    url.hash = nextFragment ? `#${nextFragment}` : "";
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function isLocalDevelopmentOrigin() {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function authErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const record = error as Record<string, unknown>;
  // EdgeBaseError reserves numeric `code` for the HTTP status and carries the
  // stable semantic identifier in `slug`. Keep legacy shapes as fallbacks.
  const code = record.slug ?? record.errorCode ?? record.error_code ?? record.code;
  return typeof code === "string" ? code.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
}

export function authErrorMessage(error: unknown) {
  const message = errorText(error);
  const normalized = message.toLowerCase();
  const code = authErrorCode(error);
  const labels = {
    invalidCredentials: i18next.t("authGate:invalidCredentials"),
    accountExists: i18next.t("authGate:accountExists"),
    tooManyAttempts: i18next.t("authGate:tooManyAttempts"),
    authOriginMismatch: i18next.t("authGate:authOriginMismatch"),
    authRejected: i18next.t("authGate:authRejected"),
    providerNotReady: i18next.t("authGate:providerNotReady"),
    signupRestricted: i18next.t("authGate:signupRestricted"),
    emailNotReady: i18next.t("authGate:emailNotReady"),
    recoveryNotAccepted: i18next.t("authGate:recoveryNotAccepted"),
    verificationNotAccepted: i18next.t("authGate:verificationNotAccepted"),
    codeExpired: i18next.t("authGate:codeExpired"),
    serviceUnavailable: i18next.t("authGate:serviceUnavailable"),
    signInFailed: i18next.t("authGate:signInFailed"),
  };
  if (
    ["invalid_credentials", "invalid_login_credentials", "invalid_password", "user_not_found"].includes(code) ||
    /invalid (?:login )?credentials|incorrect (?:email|password)|invalid password|user not found/.test(normalized)
  ) {
    return labels.invalidCredentials;
  }
  if (
    ["email_already_exists", "user_already_exists", "account_exists"].includes(code) ||
    /already (?:exists|registered|in use)|account exists/.test(normalized)
  ) {
    return labels.accountExists;
  }
  if (
    ["rate_limited", "too_many_requests", "too_many_attempts"].includes(code) ||
    /rate.?limit|too many (?:requests|attempts)|try again later/.test(normalized)
  ) {
    return labels.tooManyAttempts;
  }
  if (
    [
      "cookie_auth_origin_required",
      "cookie_auth_origin_unverifiable",
      "cookie_auth_origin_untrusted",
      "incompatible_cookie_config",
    ].includes(code) ||
    /cookie auth.*(?:origin|same.?site)|cross-site cookie auth/.test(normalized)
  ) {
    return labels.authOriginMismatch;
  }
  if (["account_disabled", "action_not_allowed", "forbidden"].includes(code)) {
    return labels.authRejected;
  }
  if (/oauth|redirect|provider/.test(`${code} ${normalized}`)) {
    return labels.providerNotReady;
  }
  if (/hook[_-]?rejected|signup is restricted|signup requires|restricted to invited/.test(`${code} ${normalized}`)) {
    return labels.signupRestricted;
  }
  if (/email delivery failed|cloudflare|email service|mail provider/.test(`${code} ${normalized}`)) {
    return labels.emailNotReady;
  }
  if (/recovery/.test(`${code} ${normalized}`)) {
    return labels.recoveryNotAccepted;
  }
  if (/mfa|two.?factor|totp/.test(`${code} ${normalized}`)) {
    return labels.verificationNotAccepted;
  }
  if (
    ["token_expired", "invalid_token", "invalid_code", "otp_expired"].includes(code) ||
    /(?:sign.?in|magic|verification) (?:code|link).*(?:invalid|expired)|token (?:is )?(?:invalid|expired)/.test(normalized)
  ) {
    return labels.codeExpired;
  }
  if (
    ["network_error", "service_unavailable", "temporarily_unavailable"].includes(code) ||
    /failed to fetch|network(?: request)? failed|service unavailable|connection refused/.test(normalized)
  ) {
    return labels.serviceUnavailable;
  }
  return labels.signInFailed;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation(["authGate", "common"]);
  const pathname = usePathname();
  const router = useRouter();
  const publicShareRoute = pathname.startsWith("/share/");
  const magicLinkRoute = pathname === "/auth/magic-link";
  const oauthCallbackRoute = pathname === "/auth/callback";
  const passwordResetRoute = pathname === "/auth/reset-password";
  const verifyEmailRoute = pathname === "/auth/verify-email";
  const verifyEmailChangeRoute = pathname === "/auth/verify-email-change";
  const authActionRoute = passwordResetRoute || verifyEmailRoute || verifyEmailChangeRoute;
  const [step, setStep] = useState<AuthStep>(() =>
    publicShareRoute ? "signed-in" : "checking"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [passwordMode, setPasswordMode] = useState<PasswordMode>("signin");
  const [resetToken, setResetToken] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState("");
  const [authActionResult, setAuthActionResult] = useState<string | null>(null);
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaMode, setMfaMode] = useState<MfaMode>("totp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localBootstrapCandidate =
    import.meta.env.DEV &&
    import.meta.env.VITE_ALLOW_ANONYMOUS_BOOTSTRAP === "true" &&
    isLocalDevelopmentOrigin();
  const [runtimeAllowsLocalBootstrap, setRuntimeAllowsLocalBootstrap] = useState(false);
  const canUseLocalBootstrap = localBootstrapCandidate && runtimeAllowsLocalBootstrap;
  const normalizedEmail = useMemo(() => email.trim().toLowerCase(), [email]);
  const [oauthProviders, setOAuthProviders] = useState<ReturnType<typeof oauthProviderOptions>>([]);

  function recordAuthAttempt(
    method:
      | "magic_link"
      | "password_signin"
      | "password_signup"
      | "oauth_signin"
      | "mfa_totp"
      | "mfa_recovery"
      | "anonymous_bootstrap",
    phase: "request" | "verify",
    outcome: "success" | "failure",
    reason?: string,
  ) {
    void recordAuthAttemptRemote({
      method,
      phase,
      outcome,
      email: normalizedEmail || undefined,
      reason,
    }).catch(() => {});
  }

  // The route-processing effect below fires on navigation, not on every render.
  // It only needs to *call* recordAuthAttempt at fire time (inside async verify
  // callbacks), never to re-run when the function identity changes. Keep it in a
  // ref refreshed each render so the effect reads the latest closure without
  // listing an unstable function in its deps (which would churn the effect).
  const recordAuthAttemptRef = useRef(recordAuthAttempt);
  const explicitAuthInFlightRef = useRef(0);
  const validatedAuthUserIdRef = useRef("");
  useEffect(() => {
    recordAuthAttemptRef.current = recordAuthAttempt;
  });

  useEffect(() => {
    if (step === "signed-in" && !publicShareRoute) {
      validatedAuthUserIdRef.current = currentUserId();
    }
  }, [publicShareRoute, step]);

  useEffect(() => {
    let mounted = true;
    fetchRuntimeConfigRemote()
      .then((config) => {
        if (mounted) setOAuthProviders(oauthProviderOptions(config.oauthProviders));
      })
      .catch(() => {
        if (mounted) setOAuthProviders([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!localBootstrapCandidate) {
      setRuntimeAllowsLocalBootstrap(false);
      return;
    }
    anonymousBootstrapAvailableRemote()
      .then((allowed) => {
        if (mounted) setRuntimeAllowsLocalBootstrap(allowed);
      })
      .catch(() => {
        if (mounted) setRuntimeAllowsLocalBootstrap(false);
      });
    return () => {
      mounted = false;
    };
  }, [localBootstrapCandidate]);

  useEffect(() => {
    if (publicShareRoute || authActionRoute) return;
    let active = true;
    let validationGeneration = 0;
    let initialEmission = true;
    let revalidatingPositiveEvent = false;
    const unsubscribe = subscribeAuthStateRemote((userId) => {
      // EdgeBase synchronously emits its current state on subscription. The
      // route effect below owns that initial server validation.
      if (initialEmission) {
        initialEmission = false;
        return;
      }
      if (!userId) {
        validatedAuthUserIdRef.current = "";
        setError(null);
        setBusy(false);
        validationGeneration += 1;
        revalidatingPositiveEvent = false;
        explicitAuthInFlightRef.current = 0;
        setStep("email");
        return;
      }

      // Routine refreshes can report the already-validated principal again.
      // Keeping the gate mounted avoids a full-screen checking flash and makes
      // the listener resilient to SDKs that emit token freshness as auth state.
      if (userId === validatedAuthUserIdRef.current) return;

      setError(null);
      setBusy(false);

      // Same-tab credentialed flows validate their own response and update the
      // gate when their promise resolves. Do not race those flows with a second
      // cookie refresh triggered by the SDK's state notification.
      if (explicitAuthInFlightRef.current > 0 || revalidatingPositiveEvent) return;
      const generation = ++validationGeneration;
      revalidatingPositiveEvent = true;

      // Cookie mode intentionally persists only a non-secret user-id hint.
      // Positive auth-state events (including cross-tab storage signals) must
      // therefore be revalidated before protected children can render.
      setStep("checking");
      void restoreAuthSessionRemote()
        .then((restoredUserId) => {
          if (!active || generation !== validationGeneration) return;
          validatedAuthUserIdRef.current = restoredUserId;
          setStep(restoredUserId ? "signed-in" : "email");
        })
        .catch((err) => {
          if (!active || generation !== validationGeneration) return;
          validatedAuthUserIdRef.current = "";
          setError(authErrorMessage(err));
          setStep("email");
        })
        .finally(() => {
          if (active && generation === validationGeneration) {
            revalidatingPositiveEvent = false;
          }
        });
    });
    return () => {
      active = false;
      validationGeneration += 1;
      unsubscribe();
    };
  }, [authActionRoute, publicShareRoute]);

  useEffect(() => {
    if (publicShareRoute) {
      setStep("signed-in");
      return;
    }

    if (passwordResetRoute) {
      const token = authCallbackParam("token") ?? "";
      // Password-reset tokens are bearer credentials. Remove them from browser
      // history before rendering the form or making any request.
      scrubAuthCallbackParams("token");
      setAuthActionResult(null);
      setResetToken(token);
      setResetPassword("");
      setResetPasswordConfirm("");
      setBusy(false);
      setError(token ? null : t("authGate:actionMissingToken"));
      setStep(token ? "password-reset" : "auth-action-result");
      return;
    }

    if (verifyEmailRoute || verifyEmailChangeRoute) {
      const token = authCallbackParam("token") ?? "";
      // Verification tokens are single-use bearer credentials too. Scrub them
      // synchronously so failure paths never retain them in browser history.
      scrubAuthCallbackParams("token");
      setAuthActionResult(null);
      setError(token ? null : t("authGate:actionMissingToken"));
      setStep("auth-action-result");
      if (!token) {
        setBusy(false);
        return;
      }

      let mounted = true;
      setBusy(true);
      const verification = verifyEmailChangeRoute
        ? verifyEmailChangeRemote(token)
        : verifyAccountEmailRemote(token);
      verification
        .then(() => {
          if (!mounted) return;
          setAuthActionResult(
            verifyEmailChangeRoute
              ? t("authGate:emailChangeVerified")
              : t("authGate:emailVerified"),
          );
        })
        .catch((err) => {
          if (mounted) setError(authErrorMessage(err));
        })
        .finally(() => {
          if (mounted) setBusy(false);
        });
      return () => {
        mounted = false;
      };
    }

    if (oauthCallbackRoute) {
      const oauthError = authCallbackParam("error") || authCallbackParam("error_description");
      if (oauthError) {
        scrubAuthCallbackParams(
          "access_token",
          "refresh_token",
          "auth_transport",
          "error",
          "error_description",
        );
        recordAuthAttemptRef.current("oauth_signin", "verify", "failure", oauthError);
        setError(t("authGate:providerNotReady"));
        setStep("email");
        return;
      }

      let mounted = true;
      explicitAuthInFlightRef.current += 1;
      setBusy(true);
      completeOAuthCallbackRemote()
        .then((userId) => {
          if (!mounted) return;
          if (!userId) throw new Error("OAuth callback did not include a session.");
          recordAuthAttemptRef.current("oauth_signin", "verify", "success");
          setStep("signed-in");
          router.replace(consumeAuthReturnPath());
        })
        .catch((err) => {
          if (!mounted) return;
          const message = authErrorMessage(err);
          recordAuthAttemptRef.current("oauth_signin", "verify", "failure", message);
          setError(message);
          setStep("email");
        })
        .finally(() => {
          explicitAuthInFlightRef.current = Math.max(0, explicitAuthInFlightRef.current - 1);
          if (mounted) setBusy(false);
        });
      return () => {
        mounted = false;
      };
    }

    if (magicLinkRoute) {
      const token = authCallbackParam("token");
      if (!token) {
        setError(t("authGate:linkMissingToken"));
        setStep("email");
        return;
      }
      // Login tokens are bearer credentials. Remove them from browser history
      // before performing any network verification, including failure paths.
      scrubAuthCallbackParams("token");

      let mounted = true;
      explicitAuthInFlightRef.current += 1;
      setBusy(true);
      setStep("magic");
      verifyMagicLinkRemote(token)
        .then(() => {
          if (!mounted) return;
          recordAuthAttemptRef.current("magic_link", "verify", "success");
          setStep("signed-in");
          router.replace(consumeAuthReturnPath());
        })
        .catch((err) => {
          if (!mounted) return;
          const message = authErrorMessage(err);
          recordAuthAttemptRef.current("magic_link", "verify", "failure", message);
          setError(message);
          setStep("email");
        })
        .finally(() => {
          explicitAuthInFlightRef.current = Math.max(0, explicitAuthInFlightRef.current - 1);
          if (mounted) setBusy(false);
        });
      return () => {
        mounted = false;
      };
    }

    let mounted = true;
    explicitAuthInFlightRef.current += 1;
    setStep("checking");
    (async () => {
      try {
        const userId = await restoreAuthSessionRemote().catch(() => "");
        if (!mounted) return;
        if (userId) {
          validatedAuthUserIdRef.current = userId;
          setStep("signed-in");
          return;
        }
        // Signed out: consult the instance/master bootstrap status before
        // rendering — it decides between the setup-blocked screen and the
        // plain form. Master credentials never cross this public endpoint.
        const status = await fetchInstanceBootstrapRemote();
        if (!mounted) return;
        if (status?.setupBlocked) {
          setStep("setup-blocked");
          return;
        }
        setStep("email");
      } finally {
        explicitAuthInFlightRef.current = Math.max(0, explicitAuthInFlightRef.current - 1);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [
    magicLinkRoute,
    oauthCallbackRoute,
    passwordResetRoute,
    publicShareRoute,
    router,
    t,
    verifyEmailChangeRoute,
    verifyEmailRoute,
  ]);

  function validatePasswordForm() {
    if (!EMAIL_RE.test(normalizedEmail)) {
      setError(t("authGate:enterValidEmail"));
      return false;
    }
    if (password.length < 10) {
      setError(t("authGate:passwordTooShort"));
      return false;
    }
    if (
      passwordMode === "signup" &&
      !(/[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password))
    ) {
      setError(t("authGate:passwordComplexity"));
      return false;
    }
    return true;
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validatePasswordForm()) return;
    const method = passwordMode === "signup" ? "password_signup" : "password_signin";
    explicitAuthInFlightRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      if (passwordMode === "signup") {
        await signUpWithPasswordRemote(normalizedEmail, password, displayName.trim() || undefined);
      } else {
        const result = await signInWithPasswordRemote(normalizedEmail, password);
        if (result.status === "mfa_required") {
          recordAuthAttempt(method, "verify", "success");
          setMfaChallenge({ ticket: result.ticket, factors: result.factors });
          setMfaCode("");
          setMfaMode("totp");
          setStep("mfa");
          return;
        }
      }
      recordAuthAttempt(method, "verify", "success");
      setStep("signed-in");
    } catch (err) {
      const message = authErrorMessage(err);
      recordAuthAttempt(method, "verify", "failure", message);
      setError(message);
    } finally {
      explicitAuthInFlightRef.current = Math.max(0, explicitAuthInFlightRef.current - 1);
      setBusy(false);
    }
  }

  async function submitPasswordResetRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!EMAIL_RE.test(normalizedEmail)) {
      setError(t("authGate:enterValidEmail"));
      return;
    }
    setBusy(true);
    setError(null);
    setAuthActionResult(null);
    try {
      await requestPasswordResetRemote(normalizedEmail);
      // Deliberately identical whether the account exists or not.
      setAuthActionResult(t("authGate:passwordResetSent"));
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetToken) {
      setError(t("authGate:actionMissingToken"));
      return;
    }
    if (resetPassword.length < 10) {
      setError(t("authGate:passwordTooShort"));
      return;
    }
    if (!(/[A-Z]/.test(resetPassword) && /[a-z]/.test(resetPassword) && /\d/.test(resetPassword) && /[^A-Za-z0-9]/.test(resetPassword))) {
      setError(t("authGate:passwordComplexity"));
      return;
    }
    if (resetPassword !== resetPasswordConfirm) {
      setError(t("authGate:passwordMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    setAuthActionResult(null);
    try {
      await resetPasswordRemote(resetToken, resetPassword);
      setResetToken("");
      setResetPassword("");
      setResetPasswordConfirm("");
      setAuthActionResult(t("authGate:passwordResetComplete"));
      setStep("auth-action-result");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function returnToSignIn() {
    setError(null);
    setAuthActionResult(null);
    setStep("checking");
    router.replace("/");
  }

  async function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mfaChallenge?.ticket) {
      setError(t("authGate:startSignInAgain"));
      setStep("email");
      return;
    }
    const normalizedCode = mfaMode === "totp" ? mfaCode.replace(/\D/g, "") : mfaCode.trim();
    if (mfaMode === "totp" && normalizedCode.length < 6) {
      setError(t("authGate:enterVerificationCode"));
      return;
    }
    if (mfaMode === "recovery" && normalizedCode.length < 6) {
      setError(t("authGate:enterRecoveryCode"));
      return;
    }
    const method = mfaMode === "totp" ? "mfa_totp" : "mfa_recovery";
    explicitAuthInFlightRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      if (mfaMode === "totp") {
        await verifyMfaTotpRemote(mfaChallenge.ticket, normalizedCode);
      } else {
        await verifyMfaRecoveryRemote(mfaChallenge.ticket, normalizedCode);
      }
      recordAuthAttempt(method, "verify", "success");
      setMfaChallenge(null);
      setMfaCode("");
      setStep("signed-in");
    } catch (err) {
      const message = authErrorMessage(err);
      recordAuthAttempt(method, "verify", "failure", message);
      setError(message);
    } finally {
      explicitAuthInFlightRef.current = Math.max(0, explicitAuthInFlightRef.current - 1);
      setBusy(false);
    }
  }

  function startOAuth(provider: string) {
    setBusy(true);
    setError(null);
    try {
      stashAuthReturnPath();
      recordAuthAttempt("oauth_signin", "request", "success");
      startOAuthSignInRemote(provider);
    } catch (err) {
      const message = authErrorMessage(err);
      recordAuthAttempt("oauth_signin", "request", "failure", message);
      setError(message);
      setBusy(false);
    }
  }

  async function continueLocally() {
    if (!canUseLocalBootstrap) {
      setError(t("authGate:guestLocalOnly"));
      return;
    }
    explicitAuthInFlightRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      await signInAnonymouslyForBootstrap();
      recordAuthAttempt("anonymous_bootstrap", "verify", "success");
      setStep("signed-in");
    } catch (err) {
      const message = authErrorMessage(err);
      recordAuthAttempt("anonymous_bootstrap", "verify", "failure", message);
      setError(message);
    } finally {
      explicitAuthInFlightRef.current = Math.max(0, explicitAuthInFlightRef.current - 1);
      setBusy(false);
    }
  }

  if (publicShareRoute) return <>{children}</>;
  if (step === "signed-in") return <MustChangePasswordGate>{children}</MustChangePasswordGate>;

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-busy={busy}>
        <div className={styles.brand}>
          {/* 36px mark: the silhouette reads at small sizes; the detailed
              illustration is reserved for >=128px surfaces (PWA icons, hero). */}
          <img className={styles.mark} src="/mark-128.png" alt="" aria-hidden="true" />
          <div>
            <h1>Hanji</h1>
            <p>{t("authGate:tagline")}</p>
          </div>
        </div>

        {step === "setup-blocked" ? (
          <div className={styles.notice} role="alert" data-testid="setup-blocked">
            <strong>{t("authGate:setupBlockedTitle")}</strong>
            <p>{t("authGate:setupBlockedBody")}</p>
            <p>
              <code>HANJI_MASTER_EMAIL=master@example.com</code>
              <br />
              <code>HANJI_MASTER_PASSWORD=••••••••••</code>
            </p>
            <p>{t("authGate:setupBlockedHint")}</p>
          </div>
        ) : step === "checking" ? (
          <div className={styles.notice} role="status" aria-live="polite">
            <strong>{t("authGate:finishingSignIn")}</strong>
            <p>{t("authGate:checkingSession")}</p>
          </div>
        ) : step === "password-reset-request" ? (
          <form className={styles.form} onSubmit={submitPasswordResetRequest}>
            <div className={styles.notice}>
              <strong>{t("authGate:forgotPasswordTitle")}</strong>
              <p>{t("authGate:forgotPasswordBody")}</p>
            </div>
            <label className={styles.label} htmlFor="auth-reset-email">{t("authGate:email")}</label>
            <input
              id="auth-reset-email"
              className={styles.input}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t("authGate:emailPlaceholder")}
              disabled={busy || Boolean(authActionResult)}
              autoFocus
            />
            {authActionResult ? (
              <p className={styles.success} role="status" aria-live="polite">{authActionResult}</p>
            ) : (
              <button className={styles.primary} type="submit" disabled={busy}>
                {t("authGate:sendResetLink")}
              </button>
            )}
            <button className={styles.linkButton} type="button" onClick={() => {
              setAuthActionResult(null);
              setError(null);
              setStep("email");
            }} disabled={busy}>
              {t("authGate:back")}
            </button>
          </form>
        ) : step === "password-reset" ? (
          <form className={styles.form} onSubmit={submitPasswordReset}>
            <div className={styles.notice}>
              <strong>{t("authGate:resetPasswordTitle")}</strong>
              <p>{t("authGate:resetPasswordBody")}</p>
            </div>
            <label className={styles.label} htmlFor="auth-reset-password">{t("authGate:newPassword")}</label>
            <input
              id="auth-reset-password"
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={resetPassword}
              onChange={(event) => setResetPassword(event.target.value)}
              disabled={busy}
              autoFocus
            />
            <label className={styles.label} htmlFor="auth-reset-password-confirm">{t("authGate:confirmPassword")}</label>
            <input
              id="auth-reset-password-confirm"
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={resetPasswordConfirm}
              onChange={(event) => setResetPasswordConfirm(event.target.value)}
              disabled={busy}
            />
            <button className={styles.primary} type="submit" disabled={busy}>
              {t("authGate:resetPasswordCta")}
            </button>
          </form>
        ) : step === "auth-action-result" ? (
          <div className={styles.notice} role="status" aria-live="polite">
            <strong>{busy ? t("authGate:verifyingAccount") : t("authGate:authActionTitle")}</strong>
            {authActionResult ? <p className={styles.success}>{authActionResult}</p> : null}
            {!busy ? (
              <button className={styles.secondary} type="button" onClick={returnToSignIn}>
                {t("authGate:returnToSignIn")}
              </button>
            ) : null}
          </div>
        ) : step === "mfa" ? (
          <form className={styles.form} onSubmit={submitMfa}>
            <div className={styles.notice}>
              <strong>{t("authGate:enterYourVerificationCode")}</strong>
              <p>
                {mfaMode === "totp" ? t("authGate:totpHint") : t("authGate:recoveryHint")}
              </p>
            </div>
            <label className={styles.label} htmlFor="auth-mfa-code">
              {mfaMode === "totp" ? t("authGate:verificationCodeLabel") : t("authGate:recoveryCodeLabel")}
            </label>
            <input
              id="auth-mfa-code"
              className={styles.input}
              inputMode={mfaMode === "totp" ? "numeric" : "text"}
              autoComplete="one-time-code"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              placeholder={mfaMode === "totp" ? "123456" : t("authGate:recoveryCodeLabel")}
              disabled={busy}
              autoFocus
            />
            <button className={styles.primary} type="submit" disabled={busy}>
              {t("authGate:verifyCode")}
            </button>
            <button
              className={styles.secondary}
              type="button"
              onClick={() => {
                setMfaMode(mfaMode === "totp" ? "recovery" : "totp");
                setMfaCode("");
                setError(null);
              }}
              disabled={busy}
            >
              {mfaMode === "totp" ? t("authGate:useRecoveryCode") : t("authGate:useAuthenticatorCode")}
            </button>
            <button
              className={styles.linkButton}
              type="button"
              onClick={() => {
                setMfaChallenge(null);
                setMfaCode("");
                setStep("email");
              }}
              disabled={busy}
            >
              {t("authGate:back")}
            </button>
          </form>
        ) : step === "magic" ? (
          <div className={styles.notice}>
            <strong>{t("authGate:finishingSignIn")}</strong>
            <p>{t("authGate:checkingLink")}</p>
            <button className={styles.linkButton} type="button" onClick={() => setStep("email")} disabled={busy}>
              {t("authGate:back")}
            </button>
          </div>
        ) : (
          <>
            <form className={styles.form} onSubmit={submitPassword}>
              {passwordMode === "signup" ? (
                <>
                  <label className={styles.label} htmlFor="auth-display-name">{t("authGate:name")}</label>
                  <input
                    id="auth-display-name"
                    className={styles.input}
                    type="text"
                    autoComplete="name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder={t("authGate:namePlaceholder")}
                    disabled={busy}
                  />
                </>
              ) : null}
              <label className={styles.label} htmlFor="auth-password-email">{t("authGate:email")}</label>
              <input
                id="auth-password-email"
                className={styles.input}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t("authGate:emailPlaceholder")}
                disabled={busy}
                autoFocus
              />
              <label className={styles.label} htmlFor="auth-password">{t("authGate:password")}</label>
              <input
                id="auth-password"
                className={styles.input}
                type="password"
                autoComplete={passwordMode === "signup" ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("authGate:password")}
                disabled={busy}
              />
              <button className={styles.primary} type="submit" disabled={busy}>
                {passwordMode === "signup" ? t("authGate:createAccount") : t("authGate:continue")}
              </button>
              {passwordMode === "signin" ? (
                <button
                  className={styles.linkButton}
                  type="button"
                  onClick={() => {
                    setAuthActionResult(null);
                    setError(null);
                    setStep("password-reset-request");
                  }}
                  disabled={busy}
                >
                  {t("authGate:forgotPassword")}
                </button>
              ) : null}
              <button
                className={styles.secondary}
                type="button"
                onClick={() => {
                  setPasswordMode(passwordMode === "signup" ? "signin" : "signup");
                  setError(null);
                }}
                disabled={busy}
              >
                {passwordMode === "signup" ? t("authGate:signInInstead") : t("authGate:createAccount")}
              </button>
            </form>
            {passwordMode === "signin" && oauthProviders.length ? (
              <ExternalAuthActions
                busy={busy}
                oauthProviders={oauthProviders}
                onOAuth={startOAuth}
              />
            ) : null}
          </>
        )}

        {error ? (
          <p className={styles.error} role="alert" aria-live="assertive">
            {error}
          </p>
        ) : null}
        {canUseLocalBootstrap ? (
          <button className={styles.devButton} type="button" onClick={() => void continueLocally()} disabled={busy}>
            {t("authGate:continueAsGuest")}
          </button>
        ) : null}
      </section>
      <SponsorBanner />
      <LegalNotice inline />
    </main>
  );
}

/**
 * Blocks the workspace UI while the signed-in account still carries an
 * admin-issued temporary password (account-state mustChangePassword flag).
 * Mounted once per sign-in transition, so the flag is checked once per
 * session, not per navigation.
 */
function MustChangePasswordGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation(["authGate", "common"]);
  const [state, setState] = useState<"checking" | "required" | "clear">("checking");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchMustChangePasswordRemote()
      .then((required) => {
        if (mounted) setState(required ? "required" : "clear");
      })
      .catch(() => {
        // The flag is hygiene, not access control: a probe failure must not
        // lock the product out.
        if (mounted) setState("clear");
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (state === "clear") return <>{children}</>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (nextPassword.length < 10) {
      setError(t("authGate:passwordTooShort"));
      return;
    }
    if (
      !(/[A-Z]/.test(nextPassword) && /[a-z]/.test(nextPassword) && /\d/.test(nextPassword) && /[^A-Za-z0-9]/.test(nextPassword))
    ) {
      setError(t("authGate:passwordComplexity"));
      return;
    }
    if (nextPassword !== confirmPassword) {
      setError(t("authGate:passwordMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePasswordRemote({ currentPassword, newPassword: nextPassword });
      await clearMustChangePasswordRemote().catch(() => {});
      setState("clear");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-busy={busy}>
        <div className={styles.brand}>
          <img className={styles.mark} src="/mark-128.png" alt="" aria-hidden="true" />
          <div>
            <h1>Hanji</h1>
            <p>{t("authGate:tagline")}</p>
          </div>
        </div>
        {state === "checking" ? (
          <div className={styles.notice} role="status" aria-live="polite">
            <strong>{t("authGate:finishingSignIn")}</strong>
            <p>{t("authGate:checkingSession")}</p>
          </div>
        ) : (
          <form className={styles.form} onSubmit={submit} data-testid="must-change-password">
            <strong>{t("authGate:mustChangeTitle")}</strong>
            <p>{t("authGate:mustChangeBody")}</p>
            <label className={styles.label} htmlFor="must-change-current">
              {t("authGate:temporaryPassword")}
            </label>
            <input
              id="must-change-current"
              className={styles.input}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={busy}
            />
            <label className={styles.label} htmlFor="must-change-next">
              {t("authGate:newPassword")}
            </label>
            <input
              id="must-change-next"
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={nextPassword}
              onChange={(event) => setNextPassword(event.target.value)}
              disabled={busy}
            />
            <label className={styles.label} htmlFor="must-change-confirm">
              {t("authGate:confirmPassword")}
            </label>
            <input
              id="must-change-confirm"
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={busy}
            />
            <button className={styles.primary} type="submit" disabled={busy}>
              {t("authGate:changePasswordCta")}
            </button>
            {error ? (
              <p className={styles.error} role="alert" aria-live="assertive">
                {error}
              </p>
            ) : null}
          </form>
        )}
      </section>
    </main>
  );
}

function ExternalAuthActions({
  busy,
  oauthProviders,
  onOAuth,
}: {
  busy: boolean;
  oauthProviders: Array<{ provider: string; label: string }>;
  onOAuth: (provider: string) => void;
}) {
  const { t } = useTranslation(["authGate", "common"]);
  if (!oauthProviders.length) return null;
  return (
    <div className={styles.externalAuth}>
      {oauthProviders.map((provider) => (
        <button
          key={provider.provider}
          className={styles.secondary}
          type="button"
          onClick={() => onOAuth(provider.provider)}
          disabled={busy}
        >
          {t("authGate:continueWith", { provider: provider.label })}
        </button>
      ))}
    </div>
  );
}
