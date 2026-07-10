"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  anonymousBootstrapAvailableRemote,
  completeOAuthCallbackRemote,
  configuredOAuthProviders,
  recordAuthAttemptRemote,
  restoreAuthSessionRemote,
  signInWithPasswordRemote,
  signUpWithPasswordRemote,
  signInAnonymouslyForBootstrap,
  startOAuthSignInRemote,
  subscribeAuthStateRemote,
  verifyMagicLinkRemote,
  verifyMfaRecoveryRemote,
  verifyMfaTotpRemote,
} from "@/lib/edgebase";
import { usePathname, useRouter } from "@/lib/router";
import { pickLabels } from "@/lib/i18n";
import styles from "./AuthGate.module.css";

const AUTH_GATE_LABELS = {
  en: {
    tagline: "Sign in to your workspace.",
    providerNotReady: "That social sign-in provider is not ready.",
    signupRestricted:
      "Account creation is restricted by administrator settings. Use an invitation or an allowed organization email.",
    emailNotReady: "Email is not ready. Check the Cloudflare Email Service settings.",
    verificationNotAccepted: "That verification code was not accepted.",
    recoveryNotAccepted: "That recovery code was not accepted.",
    codeExpired: "That sign-in code or link is no longer valid.",
    invalidCredentials: "The email or password is incorrect.",
    accountExists: "An account already exists for this email. Sign in instead.",
    tooManyAttempts: "Too many attempts. Wait a moment and try again.",
    serviceUnavailable: "The sign-in service is unavailable. Check your connection and try again.",
    signInFailed: "Sign-in failed.",
    linkMissingToken: "This sign-in link is missing its token.",
    enterValidEmail: "Enter a valid email address.",
    passwordTooShort: "Password must be at least 10 characters.",
    passwordComplexity: "Use upper and lower case letters, a number, and a symbol.",
    startSignInAgain: "Start sign-in again.",
    enterVerificationCode: "Enter the six-digit verification code.",
    enterRecoveryCode: "Enter a recovery code.",
    guestLocalOnly: "Guest access is only available in local development.",
    enterYourVerificationCode: "Enter your verification code",
    totpHint: "Use the six-digit code from your authenticator app.",
    recoveryHint: "Use one of your saved recovery codes.",
    verificationCodeLabel: "Verification code",
    recoveryCodeLabel: "Recovery code",
    verifyCode: "Verify code",
    useRecoveryCode: "Use recovery code",
    useAuthenticatorCode: "Use authenticator code",
    back: "Back",
    finishingSignIn: "Finishing sign-in",
    checkingLink: "Checking this sign-in link.",
    checkingSession: "Checking your session.",
    name: "Name",
    namePlaceholder: "June",
    email: "Email",
    emailPlaceholder: "name@company.com",
    password: "Password",
    createAccount: "Create account",
    continue: "Continue",
    signInInstead: "Sign in instead",
    continueWith: (provider: string) => `Continue with ${provider}`,
    continueAsGuest: "Continue as guest",
  },
  ko: {
    tagline: "워크스페이스에 로그인하세요.",
    providerNotReady: "해당 소셜 로그인 제공업체를 사용할 수 없습니다.",
    signupRestricted:
      "관리자 설정에 의해 계정 생성이 제한되어 있습니다. 초대 또는 허용된 조직 이메일을 사용하세요.",
    emailNotReady: "이메일을 사용할 수 없습니다. Cloudflare 이메일 서비스 설정을 확인하세요.",
    verificationNotAccepted: "인증 코드가 승인되지 않았습니다.",
    recoveryNotAccepted: "복구 코드가 승인되지 않았습니다.",
    codeExpired: "로그인 코드 또는 링크가 더 이상 유효하지 않습니다.",
    invalidCredentials: "이메일 또는 비밀번호가 올바르지 않습니다.",
    accountExists: "이 이메일로 만든 계정이 이미 있습니다. 기존 계정으로 로그인하세요.",
    tooManyAttempts: "시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.",
    serviceUnavailable: "로그인 서비스에 연결할 수 없습니다. 네트워크를 확인한 뒤 다시 시도하세요.",
    signInFailed: "로그인에 실패했습니다.",
    linkMissingToken: "이 로그인 링크에 토큰이 없습니다.",
    enterValidEmail: "올바른 이메일 주소를 입력하세요.",
    passwordTooShort: "비밀번호는 10자 이상이어야 합니다.",
    passwordComplexity: "대문자, 소문자, 숫자, 기호를 사용하세요.",
    startSignInAgain: "로그인을 다시 시작하세요.",
    enterVerificationCode: "6자리 인증 코드를 입력하세요.",
    enterRecoveryCode: "복구 코드를 입력하세요.",
    guestLocalOnly: "게스트 접근은 로컬 개발 환경에서만 사용할 수 있습니다.",
    enterYourVerificationCode: "인증 코드를 입력하세요",
    totpHint: "인증 앱의 6자리 코드를 사용하세요.",
    recoveryHint: "저장된 복구 코드 중 하나를 사용하세요.",
    verificationCodeLabel: "인증 코드",
    recoveryCodeLabel: "복구 코드",
    verifyCode: "코드 확인",
    useRecoveryCode: "복구 코드 사용",
    useAuthenticatorCode: "인증 앱 코드 사용",
    back: "뒤로",
    finishingSignIn: "로그인 마무리 중",
    checkingLink: "이 로그인 링크를 확인하고 있습니다.",
    checkingSession: "로그인 세션을 확인하고 있습니다.",
    name: "이름",
    namePlaceholder: "June",
    email: "이메일",
    emailPlaceholder: "name@company.com",
    password: "비밀번호",
    createAccount: "계정 만들기",
    continue: "계속",
    signInInstead: "기존 계정으로 로그인",
    continueWith: (provider: string) => `${provider}(으)로 계속`,
    continueAsGuest: "게스트로 계속",
  },
} as const;

function authGateLabels() {
  return pickLabels(AUTH_GATE_LABELS);
}

type AuthStep = "checking" | "email" | "magic" | "mfa" | "signed-in";
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
const AUTH_RETURN_PATH_KEY = "notionlike:auth:return-to";

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
  const labels = authGateLabels();
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
  const pathname = usePathname();
  const router = useRouter();
  const publicShareRoute = pathname.startsWith("/share/");
  const magicLinkRoute = pathname === "/auth/magic-link";
  const oauthCallbackRoute = pathname === "/auth/callback";
  const [step, setStep] = useState<AuthStep>(() =>
    publicShareRoute ? "signed-in" : "checking"
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [passwordMode, setPasswordMode] = useState<PasswordMode>("signin");
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallenge | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaMode, setMfaMode] = useState<MfaMode>("totp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localBootstrapCandidate =
    import.meta.env.VITE_ALLOW_ANONYMOUS_BOOTSTRAP === "true" &&
    isLocalDevelopmentOrigin();
  const [runtimeAllowsLocalBootstrap, setRuntimeAllowsLocalBootstrap] = useState(false);
  const canUseLocalBootstrap = localBootstrapCandidate && runtimeAllowsLocalBootstrap;
  const normalizedEmail = useMemo(() => email.trim().toLowerCase(), [email]);
  const oauthProviders = useMemo(() => configuredOAuthProviders(), []);

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
  useEffect(() => {
    recordAuthAttemptRef.current = recordAuthAttempt;
  });

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
    if (publicShareRoute) return;
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
      setError(null);
      setBusy(false);
      if (!userId) {
        validationGeneration += 1;
        revalidatingPositiveEvent = false;
        explicitAuthInFlightRef.current = 0;
        setStep("email");
        return;
      }

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
          setStep(restoredUserId ? "signed-in" : "email");
        })
        .catch((err) => {
          if (!active || generation !== validationGeneration) return;
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
  }, [publicShareRoute]);

  useEffect(() => {
    if (publicShareRoute) {
      setStep("signed-in");
      return;
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
        setError(authGateLabels().providerNotReady);
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
        setError(authGateLabels().linkMissingToken);
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
    restoreAuthSessionRemote()
      .then((userId) => {
        if (mounted) setStep(userId ? "signed-in" : "email");
      })
      .catch(() => {
        if (mounted) setStep("email");
      })
      .finally(() => {
        explicitAuthInFlightRef.current = Math.max(0, explicitAuthInFlightRef.current - 1);
      });
    return () => {
      mounted = false;
    };
  }, [magicLinkRoute, oauthCallbackRoute, publicShareRoute, router]);

  function validatePasswordForm() {
    if (!EMAIL_RE.test(normalizedEmail)) {
      setError(authGateLabels().enterValidEmail);
      return false;
    }
    if (password.length < 10) {
      setError(authGateLabels().passwordTooShort);
      return false;
    }
    if (
      passwordMode === "signup" &&
      !(/[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password))
    ) {
      setError(authGateLabels().passwordComplexity);
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

  async function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mfaChallenge?.ticket) {
      setError(authGateLabels().startSignInAgain);
      setStep("email");
      return;
    }
    const normalizedCode = mfaMode === "totp" ? mfaCode.replace(/\D/g, "") : mfaCode.trim();
    if (mfaMode === "totp" && normalizedCode.length < 6) {
      setError(authGateLabels().enterVerificationCode);
      return;
    }
    if (mfaMode === "recovery" && normalizedCode.length < 6) {
      setError(authGateLabels().enterRecoveryCode);
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
      setError(authGateLabels().guestLocalOnly);
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

  if (publicShareRoute || step === "signed-in") return <>{children}</>;

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-busy={busy}>
        <div className={styles.brand}>
          <img className={styles.mark} src="/icon-192.png" alt="" aria-hidden="true" />
          <div>
            <h1>Hanji</h1>
            <p>{authGateLabels().tagline}</p>
          </div>
        </div>

        {step === "checking" ? (
          <div className={styles.notice} role="status" aria-live="polite">
            <strong>{authGateLabels().finishingSignIn}</strong>
            <p>{authGateLabels().checkingSession}</p>
          </div>
        ) : step === "mfa" ? (
          <form className={styles.form} onSubmit={submitMfa}>
            <div className={styles.notice}>
              <strong>{authGateLabels().enterYourVerificationCode}</strong>
              <p>
                {mfaMode === "totp" ? authGateLabels().totpHint : authGateLabels().recoveryHint}
              </p>
            </div>
            <label className={styles.label} htmlFor="auth-mfa-code">
              {mfaMode === "totp" ? authGateLabels().verificationCodeLabel : authGateLabels().recoveryCodeLabel}
            </label>
            <input
              id="auth-mfa-code"
              className={styles.input}
              inputMode={mfaMode === "totp" ? "numeric" : "text"}
              autoComplete="one-time-code"
              value={mfaCode}
              onChange={(event) => setMfaCode(event.target.value)}
              placeholder={mfaMode === "totp" ? "123456" : authGateLabels().recoveryCodeLabel}
              disabled={busy}
              autoFocus
            />
            <button className={styles.primary} type="submit" disabled={busy}>
              {authGateLabels().verifyCode}
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
              {mfaMode === "totp" ? authGateLabels().useRecoveryCode : authGateLabels().useAuthenticatorCode}
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
              {authGateLabels().back}
            </button>
          </form>
        ) : step === "magic" ? (
          <div className={styles.notice}>
            <strong>{authGateLabels().finishingSignIn}</strong>
            <p>{authGateLabels().checkingLink}</p>
            <button className={styles.linkButton} type="button" onClick={() => setStep("email")} disabled={busy}>
              {authGateLabels().back}
            </button>
          </div>
        ) : (
          <>
            <form className={styles.form} onSubmit={submitPassword}>
              {passwordMode === "signup" ? (
                <>
                  <label className={styles.label} htmlFor="auth-display-name">{authGateLabels().name}</label>
                  <input
                    id="auth-display-name"
                    className={styles.input}
                    type="text"
                    autoComplete="name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder={authGateLabels().namePlaceholder}
                    disabled={busy}
                  />
                </>
              ) : null}
              <label className={styles.label} htmlFor="auth-password-email">{authGateLabels().email}</label>
              <input
                id="auth-password-email"
                className={styles.input}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={authGateLabels().emailPlaceholder}
                disabled={busy}
                autoFocus
              />
              <label className={styles.label} htmlFor="auth-password">{authGateLabels().password}</label>
              <input
                id="auth-password"
                className={styles.input}
                type="password"
                autoComplete={passwordMode === "signup" ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={authGateLabels().password}
                disabled={busy}
              />
              <button className={styles.primary} type="submit" disabled={busy}>
                {passwordMode === "signup" ? authGateLabels().createAccount : authGateLabels().continue}
              </button>
              <button
                className={styles.secondary}
                type="button"
                onClick={() => {
                  setPasswordMode(passwordMode === "signup" ? "signin" : "signup");
                  setError(null);
                }}
                disabled={busy}
              >
                {passwordMode === "signup" ? authGateLabels().signInInstead : authGateLabels().createAccount}
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
            {authGateLabels().continueAsGuest}
          </button>
        ) : null}
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
          {authGateLabels().continueWith(provider.label)}
        </button>
      ))}
    </div>
  );
}
