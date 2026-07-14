import { createClient } from "@edge-base/web";
import type {
  Block,
  CollaborationBlockStructureOperation,
  CollaborationCrdtUpdateOperation,
  Comment,
  ComputedPropertyValue,
  DbProperty,
  DbTemplate,
  DbView,
  DomainSignupPolicy,
  FileUsageReport,
  FileUpload,
  InstanceBackupSnapshot,
  InstanceAdminUser,
  InstanceSettings,
  McpOAuthGrant,
  NotionImportConnection,
  NotionImportConnectionKind,
  NotionImportItem,
  NotionImportJob,
  NotionImportRootCandidate,
  NotionImportRootScanItem,
  NotificationKind,
  NotificationRecord,
  Organization,
  OrganizationAuditEvent,
  OrganizationAuditExport,
  OrganizationBillingRecord,
  OrganizationDomain,
  OrganizationEnterpriseControls,
  OrganizationGroup,
  OrganizationLegalHold,
  OrganizationMember,
  OrganizationMemberRole,
  OrganizationProfile,
  OrganizationScimToken,
  OrganizationSharingPolicy,
  Page,
  PagePermission,
  PageParentType,
  ShareLink,
  SharePrincipalType,
  ShareRole,
  SignupPolicy,
  ServerAuditSummaryEvent,
  ServerBackupSummary,
  ServerImportJobSummary,
  ServerOverviewSummary,
  ServerSecuritySummary,
  ServerSystemSummary,
  ServerUsageSummary,
  ServerWorkspaceSummary,
  ViewType,
  Workspace,
  WorkspaceCreationPolicy,
  WorkspaceInvitation,
  WorkspaceMember,
} from "./types";
import type { TextSpanOperation } from "./textOperations";

const runtimeOrigin =
  typeof window === "undefined" ? "http://localhost:8787" : window.location.origin;
// Hanji's browser session is deliberately same-origin. The Vite development
// server proxies /api and /admin to the local EdgeBase worker; production is
// served by that worker. Keeping the API origin out of build-time environment
// variables prevents a poisoned shell or .env.local from compiling an auth and
// data exfiltration endpoint into a public bundle.
const EDGEBASE_URL = runtimeOrigin;
const OAUTH_PROVIDER_LABELS: Record<string, string> = {
  apple: "Apple",
  discord: "Discord",
  facebook: "Facebook",
  github: "GitHub",
  google: "Google",
  kakao: "Kakao",
  line: "LINE",
  microsoft: "Microsoft",
  naver: "Naver",
  reddit: "Reddit",
  slack: "Slack",
  spotify: "Spotify",
  twitch: "Twitch",
  x: "X",
};

const COLLABORATION_CLIENT_ID_KEY = "hanji.collaborationClientId";
// A CI bundle is built through `vite build`, which makes `import.meta.env.DEV`
// false even though it is served only by a local EdgeBase runtime. Keep the
// explicit opt-in in the bundle, then require the local-origin and server
// runtime gates in `anonymousBootstrapAvailableRemote` below.
const ALLOW_ANONYMOUS_BOOTSTRAP = import.meta.env.VITE_ALLOW_ANONYMOUS_BOOTSTRAP === "true";
const UPSTREAM_REPOSITORY_URL = "https://github.com/melodysdreamj/hanji";

export interface LegalLinks {
  sourceUrl: string;
  agplLicenseUrl: string;
  sponsorExceptionUrl: string;
}

export interface PublicRuntimeConfig {
  allowAnonymousBootstrap: boolean;
  oauthProviders: string[];
  notionOAuthConfigured: boolean;
  legal: LegalLinks;
}

export const DEFAULT_LEGAL_LINKS: LegalLinks = Object.freeze({
  sourceUrl: UPSTREAM_REPOSITORY_URL,
  agplLicenseUrl: `${UPSTREAM_REPOSITORY_URL}/blob/main/LICENSE`,
  sponsorExceptionUrl: `${UPSTREAM_REPOSITORY_URL}/blob/main/LICENSE-EXCEPTION`,
});

let runtimeConfigPromise: Promise<PublicRuntimeConfig> | null = null;

type Client = ReturnType<typeof createClient>;
type EdgeBaseMfaClient = Client["auth"]["mfa"];
type PasswordChangeClient = Client["auth"] & {
  changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<{ user?: { id?: string }; accessToken?: string; refreshToken?: string }>;
};
type MfaRecoveryCodeClient = EdgeBaseMfaClient & {
  regenerateRecoveryCodes(input: { password?: string; code?: string }): Promise<{ recoveryCodes?: string[] }>;
};
export type CollaborationOperationPayload =
  | TextSpanOperation
  | CollaborationBlockStructureOperation
  | CollaborationCrdtUpdateOperation
  | Record<string, unknown>;
export type WorkspaceMutationPatch = Omit<Partial<Workspace>, "icon" | "domain"> & {
  icon?: string | null;
  domain?: string | null;
};

let _client: Client | null = null;
let ensureAuthPromise: Promise<string> | null = null;
let ensuredAuthUserId = "";

function browserClientId() {
  if (typeof window === "undefined") return "server";
  const existing = window.localStorage.getItem(COLLABORATION_CLIENT_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  window.localStorage.setItem(COLLABORATION_CLIENT_ID_KEY, id);
  return id;
}

function isLocalDevelopmentOrigin() {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

export function normalizeLegalLinks(value: unknown): LegalLinks {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const safeUrl = (candidate: unknown, fallback: string) => {
    if (typeof candidate !== "string") return fallback;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" || url.username || url.password) return fallback;
      const hostname = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
      if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname === "0.0.0.0" ||
        hostname === "::1" ||
        hostname === "::" ||
        /^(?:fc|fd)[0-9a-f]{2}:/.test(hostname) ||
        /^fe[89ab][0-9a-f]:/.test(hostname) ||
        /^127\./.test(hostname) ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) ||
        /^169\.254\./.test(hostname)
      ) {
        return fallback;
      }
      return url.toString();
    } catch {
      return fallback;
    }
  };
  return {
    sourceUrl: safeUrl(record.sourceUrl, DEFAULT_LEGAL_LINKS.sourceUrl),
    agplLicenseUrl: safeUrl(record.agplLicenseUrl, DEFAULT_LEGAL_LINKS.agplLicenseUrl),
    sponsorExceptionUrl: safeUrl(
      record.sponsorExceptionUrl,
      DEFAULT_LEGAL_LINKS.sponsorExceptionUrl,
    ),
  };
}

async function requestRuntimeConfig(): Promise<PublicRuntimeConfig> {
  const response = await fetch(`${EDGEBASE_URL}/api/functions/runtime-config`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`runtime config returned HTTP ${response.status}`);
  const json = await response.json() as {
    allowAnonymousBootstrap?: unknown;
    oauthProviders?: unknown;
    notionOAuthConfigured?: unknown;
    legal?: unknown;
  };
  return {
    allowAnonymousBootstrap: json.allowAnonymousBootstrap === true,
    oauthProviders: Array.isArray(json.oauthProviders)
      ? Array.from(new Set(json.oauthProviders
          .filter((provider): provider is string => typeof provider === "string")
          .map((provider) => provider.trim())
          .filter((provider) => /^[a-z][a-z0-9_-]{0,31}$/.test(provider))))
      : [],
    notionOAuthConfigured: json.notionOAuthConfigured === true,
    legal: normalizeLegalLinks(json.legal),
  };
}

function loadRuntimeConfig() {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = requestRuntimeConfig().catch((error) => {
      runtimeConfigPromise = null;
      throw error;
    });
  }
  return runtimeConfigPromise;
}

export async function fetchRuntimeConfigRemote(): Promise<PublicRuntimeConfig> {
  try {
    return await loadRuntimeConfig();
  } catch {
    return {
      allowAnonymousBootstrap: false,
      oauthProviders: [],
      notionOAuthConfigured: false,
      legal: DEFAULT_LEGAL_LINKS,
    };
  }
}

export interface InstanceBootstrapStatus {
  masterConfigured: boolean;
  masterReady: boolean;
  setupBlocked: boolean;
  setupAvailable: boolean;
  setupAuthorizationRequired: boolean;
  setupInProgress: boolean;
}

/**
 * Instance/master bootstrap status. Also triggers the idempotent server-side
 * master-account ensure. Returns null on any failure so the sign-in screen
 * degrades to its normal form instead of blocking on this probe.
 */
export async function fetchInstanceBootstrapRemote(
  setupToken?: string,
): Promise<InstanceBootstrapStatus | null> {
  try {
    const response = await fetch(`${EDGEBASE_URL}/api/functions/instance-bootstrap`, {
      headers: {
        Accept: "application/json",
        ...(setupToken ? { "X-Hanji-Setup-Token": setupToken } : {}),
      },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const json = await response.json() as Record<string, unknown>;
    return {
      masterConfigured: json.masterConfigured === true,
      masterReady: json.masterReady === true,
      setupBlocked: json.setupBlocked === true,
      setupAvailable: json.setupAvailable === true,
      setupAuthorizationRequired: json.setupAuthorizationRequired === true,
      setupInProgress: json.setupInProgress === true,
    };
  } catch {
    return null;
  }
}

export interface InitializeInstanceInput {
  email: string;
  password: string;
  displayName?: string;
}

/** Complete the one-time, durable first-administrator claim. */
export async function initializeInstanceRemote(
  input: InitializeInstanceInput,
  setupToken?: string,
): Promise<void> {
  const response = await fetch(`${EDGEBASE_URL}/api/functions/instance-bootstrap`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(setupToken ? { "X-Hanji-Setup-Token": setupToken } : {}),
    },
    cache: "no-store",
    body: JSON.stringify({ action: "completeSetup", ...input }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok) return;
  const error = Object.assign(
    new Error(typeof payload.message === "string" ? payload.message : "Instance setup failed."),
    { status: response.status },
  );
  throw error;
}

/** True when the signed-in account holds an admin-issued temporary password. */
export async function fetchMustChangePasswordRemote(): Promise<boolean> {
  const result = await getClient().functions.post<{ ok?: boolean; mustChangePassword?: boolean }>(
    "account-state",
    { action: "get" },
  );
  return result?.mustChangePassword === true;
}

export async function clearMustChangePasswordRemote(): Promise<void> {
  await getClient().functions.post("account-state", { action: "clearMustChangePassword" });
}

export interface AccountLanguageState {
  languagePreference: string | null;
  languageOnboardingCompleted: boolean;
}

/** Durable language preference for the current authenticated account. */
export async function fetchAccountLanguageStateRemote(): Promise<AccountLanguageState> {
  const result = await getClient().functions.post<{
    languagePreference?: unknown;
    languageOnboardingCompleted?: unknown;
  }>("account-state", { action: "get" });
  return {
    languagePreference:
      typeof result?.languagePreference === "string" ? result.languagePreference : null,
    languageOnboardingCompleted: result?.languageOnboardingCompleted === true,
  };
}

export async function saveAccountLanguagePreferenceRemote(
  languagePreference: string,
): Promise<AccountLanguageState> {
  const result = await getClient().functions.post<{
    languagePreference?: unknown;
    languageOnboardingCompleted?: unknown;
  }>("account-state", { action: "setLanguagePreference", languagePreference });
  return {
    languagePreference:
      typeof result?.languagePreference === "string" ? result.languagePreference : null,
    languageOnboardingCompleted: result?.languageOnboardingCompleted === true,
  };
}

export interface SponsorEntry {
  name: string;
  url: string | null;
}

export interface SponsorFeed {
  sponsors: SponsorEntry[];
  /** True only when the operator turned the banner feature off (plain AGPL). An
   *  empty `sponsors` in live/bundled mode just means "no sponsors yet". */
  disabled: boolean;
}

/** Public sponsor feed for the sign-in banner (no auth required). */
export async function fetchSponsorsRemote(): Promise<SponsorFeed> {
  try {
    const response = await fetch(`${EDGEBASE_URL}/api/functions/sponsors`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return { sponsors: [], disabled: false };
    const json = await response.json() as { sponsors?: unknown; disabled?: unknown };
    const sponsors = Array.isArray(json.sponsors)
      ? (json.sponsors as SponsorEntry[]).filter((item) => typeof item?.name === "string")
      : [];
    return { sponsors, disabled: json.disabled === true };
  } catch {
    return { sponsors: [], disabled: false };
  }
}

export interface ImportedPersonEntry {
  sourceId: string;
  displayName: string | null;
  email: string | null;
  propertyValueCount: number;
  mentionCount: number;
  suggestedUserId: string | null;
  suggestedDisplayName: string | null;
}

export interface ImportedPeopleResult {
  people: ImportedPersonEntry[];
  members: Array<{ userId: string; displayName: string | null; email: string | null; role: string | null }>;
}

/** Imported (notion-user:*) person references remaining in a workspace. */
export async function listImportedPeopleRemote(workspaceId: string): Promise<ImportedPeopleResult> {
  const result = await getClient().functions.post<ImportedPeopleResult>("person-mapping", {
    action: "list",
    workspaceId,
  });
  return {
    people: Array.isArray(result?.people) ? result.people : [],
    members: Array.isArray(result?.members) ? result.members : [],
  };
}

export async function applyPersonMappingsRemote(
  workspaceId: string,
  mappings: Record<string, string>,
): Promise<{ mappedPeople: number; changedPages: number; changedBlocks: number; changedMentions: number }> {
  return getClient().functions.post("person-mapping", { action: "apply", workspaceId, mappings });
}

export async function anonymousBootstrapAvailableRemote(): Promise<boolean> {
  if (!ALLOW_ANONYMOUS_BOOTSTRAP || !isLocalDevelopmentOrigin()) return false;
  try {
    return (await loadRuntimeConfig()).allowAnonymousBootstrap;
  } catch {
    return false;
  }
}

/** Lazily create the browser-only EdgeBase client (guards against SSR). */
export function getClient(): Client {
  if (typeof window === "undefined") {
    throw new Error("EdgeBase client is browser-only");
  }
  if (!_client) {
    _client = createClient(EDGEBASE_URL, {
      refreshTokenTransport: "httpOnlyCookie",
    });
  }
  return _client;
}

const INTERACTIVE_MUTATION_TIMEOUT_MS = 15_000;

function callInteractiveMutation<T>(name: string, body: Record<string, unknown>) {
  return getClient().functions.call<T>(name, {
    method: "POST",
    body,
    timeoutMs: INTERACTIVE_MUTATION_TIMEOUT_MS,
  });
}

function authFailureStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const value = record.status ?? record.code;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isDefinitiveAuthFailure(error: unknown): boolean {
  const status = authFailureStatus(error);
  return status === 401 || status === 403;
}

/**
 * Restore a browser session from EdgeBase's HttpOnly refresh cookie. This is
 * intentionally explicit because JavaScript cannot inspect the cookie, and it
 * also handles the one-time migration from older localStorage refresh tokens.
 */
export async function restoreAuthSessionRemote(): Promise<string> {
  const client = getClient();
  const current = () => client.auth.currentUser as { id?: string } | null;
  try {
    const result = await client.auth.refreshSession();
    return result.user?.id ?? current()?.id ?? "";
  } catch (error) {
    // A server rejection is authoritative. EdgeBase has already cleared the
    // stale local marker/migration token; never revive that cached identity.
    if (isDefinitiveAuthFailure(error)) return "";

    // On network/5xx failures only, an existing non-secret cached identity may
    // continue in local-first mode. A browser with no cached user remains
    // signed out until its cookie can be verified online.
    const status = authFailureStatus(error);
    if (status === 0 || (status !== null && status >= 500)) {
      return current()?.id ?? "";
    }
    throw error;
  }
}

/**
 * Ensure we have an authenticated product session. Anonymous auth remains
 * available only through the explicit local bootstrap helper below.
 */
export async function ensureAuth(): Promise<string> {
  const client = getClient();
  const current = () => client.auth.currentUser as { id?: string } | null;
  const currentId = current()?.id ?? "";
  if (currentId && currentId === ensuredAuthUserId) return currentId;
  if (ensureAuthPromise) return ensureAuthPromise;

  ensureAuthPromise = (async () => {
    const restoredUserId = await restoreAuthSessionRemote();
    if (restoredUserId) {
      ensuredAuthUserId = restoredUserId;
      return restoredUserId;
    }

    if (await anonymousBootstrapAvailableRemote()) {
      const res = await client.auth.signInAnonymously();
      const user = (res as { user?: { id?: string } }).user;
      const anonymousUserId = user?.id ?? current()?.id ?? "";
      if (anonymousUserId) {
        ensuredAuthUserId = anonymousUserId;
        return anonymousUserId;
      }
    }
    throw new Error("Email sign-in required.");
  })().finally(() => {
    ensureAuthPromise = null;
  });

  return ensureAuthPromise;
}

export function subscribeAuthStateRemote(listener: (userId: string) => void): () => void {
  return getClient().auth.onAuthStateChange((user) => {
    const userId = user?.id ?? "";
    if (!userId) ensuredAuthUserId = "";
    listener(userId);
  });
}

export function currentUserId(): string {
  return ((getClient().auth.currentUser as { id?: string } | null)?.id ?? "").trim();
}

export function currentUserIsAnonymous(): boolean {
  return (getClient().auth.currentUser as { isAnonymous?: boolean } | null)?.isAnonymous === true;
}

/**
 * Non-secret, non-authoritative cookie-session hint for selecting the matching
 * account-scoped local cache before the online refresh finishes.
 */
export function currentSessionUserIdHint(): string {
  return (getClient().auth.sessionUserIdHint ?? "").trim();
}

export function currentUserEmail(): string {
  return (
    (getClient().auth.currentUser as { email?: string } | null)?.email ?? ""
  ).trim().toLowerCase();
}

export async function requestEmailCodeRemote(email: string): Promise<void> {
  await getClient().auth.signInWithEmailOtp({ email });
}

export interface AuthAuditInput {
  method:
    | "email_otp"
    | "magic_link"
    | "password_signin"
    | "password_signup"
    | "passkey_signin"
    | "oauth_signin"
    | "mfa_totp"
    | "mfa_recovery"
    | "anonymous_bootstrap";
  phase: "request" | "verify";
  outcome: "success" | "failure";
  email?: string;
  reason?: string;
}

export async function recordAuthAttemptRemote(input: AuthAuditInput): Promise<void> {
  await getClient().functions.post("auth-audit", {
    action: "record",
    ...input,
  });
}

export async function verifyEmailCodeRemote(email: string, code: string): Promise<string> {
  const result = await getClient().auth.verifyEmailOtp({ email, code });
  clearWorkspaceCache();
  return result.user?.id ?? currentUserId();
}

export async function requestMagicLinkRemote(email: string): Promise<void> {
  // Use the server-pinned email.magicLinkUrl fallback. It keeps the bearer
  // token in the URL fragment and cannot drift to a caller-supplied route.
  await getClient().auth.signInWithMagicLink({ email });
}

export async function verifyMagicLinkRemote(token: string): Promise<string> {
  const result = await getClient().auth.verifyMagicLink(token);
  clearWorkspaceCache();
  return result.user?.id ?? currentUserId();
}

export interface PasswordSignInMfaChallenge {
  status: "mfa_required";
  ticket: string;
  factors: Array<{ id: string; type: string }>;
}

export interface PasswordSignInSuccess {
  status: "signed_in";
  userId: string;
}

export type PasswordSignInResult = PasswordSignInSuccess | PasswordSignInMfaChallenge;

export type PasskeySignInResult = PasswordSignInResult;

export async function signInWithPasswordRemote(email: string, password: string): Promise<PasswordSignInResult> {
  const result = await getClient().auth.signIn({ email, password });
  if (!("accessToken" in result)) {
    return {
      status: "mfa_required",
      ticket: result.mfaTicket,
      factors: result.factors ?? [],
    };
  }
  clearWorkspaceCache();
  return { status: "signed_in", userId: result.user?.id ?? currentUserId() };
}

export async function signUpWithPasswordRemote(
  email: string,
  password: string,
  displayName?: string
): Promise<string> {
  const result = await getClient().auth.signUp({
    email,
    password,
    data: displayName ? { displayName } : undefined,
  });
  clearWorkspaceCache();
  return result.user?.id ?? currentUserId();
}

export async function changePasswordRemote(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await (getClient().auth as PasswordChangeClient).changePassword(input);
  clearWorkspaceCache();
}

export async function requestPasswordResetRemote(email: string): Promise<void> {
  // Use the server-pinned email.resetUrl fallback. It keeps the bearer token
  // in the URL fragment and cannot drift to a caller-supplied route.
  await getClient().auth.requestPasswordReset(email);
}

export async function resetPasswordRemote(token: string, newPassword: string): Promise<void> {
  await getClient().auth.resetPassword(token, newPassword);
  clearWorkspaceCache();
}

export async function verifyAccountEmailRemote(token: string): Promise<void> {
  await getClient().auth.verifyEmail(token);
}

export async function verifyEmailChangeRemote(token: string): Promise<void> {
  await getClient().auth.verifyEmailChange(token);
  clearWorkspaceCache();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing.`);
  return value;
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = window.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function bufferToBase64Url(buffer: ArrayBuffer | null): string | null {
  if (!buffer) return null;
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function prepareCredentialDescriptor(value: unknown) {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id, "Credential id");
  return {
    ...value,
    id: base64UrlToBuffer(id),
  } as PublicKeyCredentialDescriptor;
}

function prepareCreationOptions(value: unknown): PublicKeyCredentialCreationOptions {
  if (!isRecord(value)) throw new Error("Passkey registration options are invalid.");
  const user = isRecord(value.user) ? value.user : null;
  if (!user) throw new Error("Passkey registration user is missing.");
  return {
    ...value,
    challenge: base64UrlToBuffer(requiredString(value.challenge, "Passkey challenge")),
    user: {
      ...user,
      id: base64UrlToBuffer(requiredString(user.id, "Passkey user id")),
    },
    excludeCredentials: Array.isArray(value.excludeCredentials)
      ? value.excludeCredentials.map(prepareCredentialDescriptor).filter(Boolean)
      : undefined,
  } as PublicKeyCredentialCreationOptions;
}

function prepareRequestOptions(value: unknown): PublicKeyCredentialRequestOptions {
  if (!isRecord(value)) throw new Error("Passkey sign-in options are invalid.");
  return {
    ...value,
    challenge: base64UrlToBuffer(requiredString(value.challenge, "Passkey challenge")),
    allowCredentials: Array.isArray(value.allowCredentials)
      ? value.allowCredentials.map(prepareCredentialDescriptor).filter(Boolean)
      : undefined,
  } as PublicKeyCredentialRequestOptions;
}

function credentialToJson(credential: PublicKeyCredential) {
  const common = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
  };

  if (
    typeof AuthenticatorAttestationResponse !== "undefined" &&
    credential.response instanceof AuthenticatorAttestationResponse
  ) {
    return {
      ...common,
      response: {
        attestationObject: bufferToBase64Url(credential.response.attestationObject),
        clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
        transports:
          typeof credential.response.getTransports === "function"
            ? credential.response.getTransports()
            : undefined,
      },
    };
  }

  if (
    typeof AuthenticatorAssertionResponse !== "undefined" &&
    credential.response instanceof AuthenticatorAssertionResponse
  ) {
    return {
      ...common,
      response: {
        authenticatorData: bufferToBase64Url(credential.response.authenticatorData),
        clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
        signature: bufferToBase64Url(credential.response.signature),
        userHandle: bufferToBase64Url(credential.response.userHandle),
      },
    };
  }

  throw new Error("Unsupported passkey response.");
}

function ensurePasskeyAvailable() {
  if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("Passkeys are not available in this browser.");
  }
}

function normalizeAuthResult(result: unknown): PasskeySignInResult {
  if (isRecord(result) && result.mfaRequired === true) {
    return {
      status: "mfa_required",
      ticket: requiredString(result.mfaTicket, "MFA ticket"),
      factors: Array.isArray(result.factors)
        ? result.factors.filter(isRecord).map((factor) => ({
            id: String(factor.id ?? ""),
            type: String(factor.type ?? ""),
          }))
        : [],
    };
  }
  const signedIn: PasswordSignInSuccess = {
    status: "signed_in",
    userId: isRecord(result) && isRecord(result.user) && typeof result.user.id === "string"
      ? result.user.id
      : currentUserId(),
  };
  clearWorkspaceCache();
  return signedIn;
}

export async function signInWithPasskeyRemote(email?: string): Promise<PasskeySignInResult> {
  ensurePasskeyAvailable();
  const result = await getClient().auth.passkeysAuthOptions(email ? { email } : undefined);
  const options = prepareRequestOptions(isRecord(result) ? result.options : result);
  const credential = await navigator.credentials.get({ publicKey: options });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Passkey sign-in was cancelled.");
  return normalizeAuthResult(await getClient().auth.passkeysAuthenticate(credentialToJson(credential)));
}

export interface PasskeyRecord {
  id: string;
  credentialId: string;
  transports?: string[];
  createdAt?: string;
}

export async function listPasskeysRemote(): Promise<PasskeyRecord[]> {
  const result = await getClient().auth.passkeysList();
  return isRecord(result) && Array.isArray(result.passkeys)
    ? result.passkeys.filter(isRecord).map((passkey) => ({
        id: String(passkey.id ?? passkey.credentialId ?? ""),
        credentialId: String(passkey.credentialId ?? ""),
        transports: Array.isArray(passkey.transports)
          ? passkey.transports.map((transport) => String(transport))
          : [],
        createdAt: typeof passkey.createdAt === "string" ? passkey.createdAt : undefined,
      })).filter((passkey) => passkey.credentialId)
    : [];
}

export async function registerPasskeyRemote(): Promise<string> {
  ensurePasskeyAvailable();
  const result = await getClient().auth.passkeysRegisterOptions();
  const options = prepareCreationOptions(isRecord(result) ? result.options : result);
  const credential = await navigator.credentials.create({ publicKey: options });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Passkey registration was cancelled.");
  const registered = await getClient().auth.passkeysRegister(credentialToJson(credential));
  if (!isRecord(registered) || typeof registered.credentialId !== "string") return credential.id;
  return registered.credentialId;
}

export async function deletePasskeyRemote(credentialId: string): Promise<void> {
  await getClient().auth.passkeysDelete(credentialId);
}

export interface OAuthProviderOption {
  provider: string;
  label: string;
}

export interface McpConnectionsResult {
  ok: boolean;
  mcpServerUrl: string;
  authorizationServerMetadataUrl: string;
  protectedResourceMetadataUrl: string;
  defaultScopes: string[];
  accessibleWorkspaceCount: number;
  grants: McpOAuthGrant[];
}

export interface McpCreatedToken {
  grant: McpOAuthGrant;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt?: string | null;
}

export interface McpCreateTokenResult extends McpConnectionsResult {
  createdToken?: McpCreatedToken;
}

export function oauthProviderOptions(providers: readonly string[]): OAuthProviderOption[] {
  return providers
    .map((provider) => provider.trim())
    .filter((provider) => /^[a-z][a-z0-9_-]{0,31}$/.test(provider))
    .map((provider) => ({ provider, label: OAUTH_PROVIDER_LABELS[provider] ?? provider }));
}

export function startOAuthSignInRemote(provider: string): void {
  const redirectUrl = typeof window === "undefined" ? undefined : `${window.location.origin}/auth/callback`;
  getClient().auth.signInWithOAuth(provider, { redirectUrl });
}

export async function completeOAuthCallbackRemote(): Promise<string | null> {
  const result = await getClient().auth.handleOAuthCallback();
  if (!result) return null;
  clearWorkspaceCache();
  return result.user?.id ?? currentUserId();
}

export async function listMcpConnectionsRemote(): Promise<McpConnectionsResult> {
  return getClient().functions.post<McpConnectionsResult>("mcp-connections", {
    action: "list",
  });
}

export async function revokeMcpConnectionRemote(grantId: string): Promise<McpConnectionsResult> {
  return getClient().functions.post<McpConnectionsResult>("mcp-connections", {
    action: "revoke",
    grantId,
  });
}

export async function createManualMcpTokenRemote(clientName = "Manual MCP token"): Promise<McpCreateTokenResult> {
  return getClient().functions.post<McpCreateTokenResult>("mcp-connections", {
    action: "createManualToken",
    clientName,
  });
}

export async function verifyMfaTotpRemote(ticket: string, code: string): Promise<string> {
  const result = await getClient().auth.mfa.verifyTotp(ticket, code);
  clearWorkspaceCache();
  return result.user?.id ?? currentUserId();
}

export async function verifyMfaRecoveryRemote(ticket: string, recoveryCode: string): Promise<string> {
  const result = await getClient().auth.mfa.useRecoveryCode(ticket, recoveryCode);
  clearWorkspaceCache();
  return result.user?.id ?? currentUserId();
}

export interface MfaFactor {
  id: string;
  type: string;
  verified?: boolean;
  createdAt?: string;
}

export interface TotpEnrollment {
  factorId: string;
  secret: string;
  qrCodeUri: string;
  recoveryCodes: string[];
}

export interface AuthSession {
  id: string;
  createdAt: string;
  userAgent?: string;
  ip?: string;
  current?: boolean;
}

export async function listMfaFactorsRemote(): Promise<MfaFactor[]> {
  const result = await getClient().auth.mfa.listFactors();
  return result.factors ?? [];
}

export async function enrollTotpRemote(): Promise<TotpEnrollment> {
  return getClient().auth.mfa.enrollTotp();
}

export async function verifyTotpEnrollmentRemote(factorId: string, code: string): Promise<void> {
  await getClient().auth.mfa.verifyTotpEnrollment(factorId, code);
}

export async function disableTotpRemote(input: { password?: string; code?: string }): Promise<void> {
  await getClient().auth.mfa.disableTotp(input);
}

export async function regenerateRecoveryCodesRemote(input: { password?: string; code?: string }): Promise<string[]> {
  const mfa = getClient().auth.mfa as EdgeBaseMfaClient & Partial<MfaRecoveryCodeClient>;
  if (typeof mfa.regenerateRecoveryCodes !== "function") {
    throw new Error("Recovery code regeneration is not available in this EdgeBase client.");
  }
  const result = await mfa.regenerateRecoveryCodes(input);
  return result.recoveryCodes ?? [];
}

export async function listAuthSessionsRemote(): Promise<AuthSession[]> {
  return getClient().auth.listSessions();
}

export async function revokeAuthSessionRemote(sessionId: string): Promise<void> {
  await getClient().auth.revokeSession(sessionId);
}

export async function signOutRemote(): Promise<void> {
  // EdgeBase cookie-mode sign-out clears its JavaScript-visible session and
  // writes the retry tombstone synchronously before waiting on the network.
  // Reset product caches at the same local-first boundary so an offline or
  // stalled revoke cannot leave this tab presenting a trusted session.
  const remoteSignOut = getClient().auth.signOut();
  ensuredAuthUserId = "";
  ensureAuthPromise = null;
  clearWorkspaceCache();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("hanji:clear-signed-file-url-cache"));
    window.dispatchEvent(new Event("hanji:clear-offline-file-cache"));
  }
  await remoteSignOut;
}

export async function signInAnonymouslyForBootstrap(): Promise<string> {
  if (!(await anonymousBootstrapAvailableRemote())) {
    throw new Error("Anonymous bootstrap is disabled.");
  }
  const res = await getClient().auth.signInAnonymously();
  const user = (res as { user?: { id?: string } }).user;
  return user?.id ?? currentUserId();
}

const WS_KEY = "hanji.workspaceId";

function clearWorkspaceCache() {
  try {
    localStorage.removeItem(WS_KEY);
  } catch {
    // localStorage can be unavailable in private or constrained contexts.
  }
}

export function rememberWorkspaceCache(workspaceId: string | undefined) {
  try {
    if (workspaceId) localStorage.setItem(WS_KEY, workspaceId);
    else localStorage.removeItem(WS_KEY);
  } catch {
    // localStorage can be unavailable in private or constrained contexts.
  }
}

export interface WorkspaceBootstrapResult {
  userId: string;
  isInstanceAdmin?: boolean;
  workspace: Workspace;
  organization?: Organization | null;
  organizations?: Organization[];
  currentOrganizationMember?: OrganizationMember | null;
  organizationMembers?: OrganizationMember[];
  organizationGroups?: OrganizationGroup[];
  organizationProfiles?: OrganizationProfile[];
  organizationDomains?: OrganizationDomain[];
  organizationAuditEvents?: OrganizationAuditEvent[];
  enterpriseControls?: OrganizationEnterpriseControls;
  organizationScimTokens?: OrganizationScimToken[];
  organizationLegalHolds?: OrganizationLegalHold[];
  organizationAuditExports?: OrganizationAuditExport[];
  organizationBillingRecords?: OrganizationBillingRecord[];
  workspaces?: Workspace[];
  currentMember?: WorkspaceMember;
  members?: WorkspaceMember[];
  /** Full page list; absent when pagesDelta is true. */
  pages?: Page[];
  pageRoles?: Record<string, ShareRole>;
  sharedPageIds?: string[];
  /** Delta sync (local-first §7): server watermark to echo back as pagesSince. */
  pagesSyncedAt?: string;
  /** Change-feed cursor to echo back as changesSince (§7 v2). */
  changesSyncedAt?: string;
  /** True when the response carries a delta instead of pages. */
  pagesDelta?: boolean;
  /** 'changes': O(changes) tombstone mode; 'ids': visible-id-list mode. */
  deltaMode?: "changes" | "ids";
  changedPages?: Page[];
  visiblePageIds?: string[];
  deletedPageIds?: string[];
  /** Skip hints from the change feed (undefined = unknown, do not skip). */
  changedDatabaseIds?: string[];
  changedBlockPageIds?: string[];
}

export interface WorkspaceBootstrapInput {
  workspaceId?: string;
  workspaceSlug?: string;
  pageId?: string;
  /** Watermark from a previous bootstrap; asks the server for a pages delta. */
  pagesSince?: string;
  /** Change-feed cursor from a previous bootstrap (enables tombstone mode). */
  changesSince?: string;
}

export async function bootstrapWorkspace(
  input: WorkspaceBootstrapInput = {}
): Promise<WorkspaceBootstrapResult> {
  const fallbackUserId = await ensureAuth();
  const cachedWorkspaceId = localStorage.getItem(WS_KEY) ?? undefined;
  const body: Record<string, string> = {};
  const canRetryWithoutImplicitCache =
    !!cachedWorkspaceId &&
    !input.workspaceId &&
    !input.workspaceSlug &&
    !input.pageId;
  if (input.workspaceId) body.workspaceId = input.workspaceId;
  else if (cachedWorkspaceId) body.workspaceId = cachedWorkspaceId;
  if (input.workspaceSlug) body.workspaceSlug = input.workspaceSlug;
  if (input.pageId) body.pageId = input.pageId;
  if (input.pagesSince) body.pagesSince = input.pagesSince;
  if (input.changesSince) body.changesSince = input.changesSince;
  let result: WorkspaceBootstrapResult;
  try {
    result = await getClient().functions.post<WorkspaceBootstrapResult>(
      "workspace-bootstrap",
      body
    );
  } catch (error) {
    if (!canRetryWithoutImplicitCache) throw error;
    clearWorkspaceCache();
    result = await getClient().functions.post<WorkspaceBootstrapResult>(
      "workspace-bootstrap",
      {}
    );
  }

  localStorage.setItem(WS_KEY, result.workspace.id);
  return {
    ...result,
    userId: result.userId || fallbackUserId,
    pages: result.pages ?? [],
    pageRoles: result.pageRoles ?? {},
    sharedPageIds: result.sharedPageIds ?? [],
  };
}

export async function updateWorkspaceRemote(
  id: string,
  patch: WorkspaceMutationPatch
): Promise<Workspace> {
  const result = await getClient().functions.post<{ workspace: Workspace }>("workspace-mutation", {
    action: "update",
    id,
    patch,
  });
  return result.workspace;
}

/** Atomically claims the one-time first-admin Notion import prompt. */
export async function claimNotionImportOnboardingRemote(
  workspaceId: string,
): Promise<{ show: boolean }> {
  const result = await getClient().functions.post<{ show?: unknown }>("workspace-mutation", {
    action: "claimNotionImportOnboarding",
    workspaceId,
  });
  return { show: result?.show === true };
}

/** Suppress the prompt when workspace creation already asked how to start. */
export async function suppressNotionImportOnboardingRemote(
  workspaceId: string,
): Promise<void> {
  await getClient().functions.post("workspace-mutation", {
    action: "suppressNotionImportOnboarding",
    workspaceId,
  });
}

export interface CreateWorkspaceInput {
  name: string;
  icon?: string | null;
  domain?: string | null;
  organizationId?: string | null;
  /** Skip the starter pages when the creation flow imports content next. */
  skipDefaultPages?: boolean;
  /** Record that this flow already asked how the workspace should start. */
  suppressNotionImportOnboarding?: boolean;
}

export async function createWorkspaceRemote(
  input: CreateWorkspaceInput
): Promise<WorkspaceMembersResult> {
  return getClient().functions.post<WorkspaceMembersResult>("workspace-mutation", {
    action: "createWorkspace",
    ...input,
  });
}

export async function listWorkspacesRemote(): Promise<{ workspaces: Workspace[] }> {
  return getClient().functions.post<{ workspaces: Workspace[] }>("workspace-mutation", {
    action: "list",
  });
}

export interface DeleteWorkspaceInput {
  confirmWorkspaceName?: string;
}

export async function deleteWorkspaceRemote(
  workspaceId: string,
  input: DeleteWorkspaceInput = {},
): Promise<{ deletedId: string; workspaces: Workspace[]; organizations?: Organization[] }> {
  return getClient().functions.post<{ deletedId: string; workspaces: Workspace[]; organizations?: Organization[] }>("workspace-mutation", {
    action: "deleteWorkspace",
    workspaceId,
    ...input,
  });
}

export interface NotionImportJobResult {
  job: NotionImportJob;
  items?: NotionImportItem[];
}

export interface NotionImportPlanResult extends NotionImportJobResult {
  plan?: {
    status?: "ready" | "blocked";
    generatedAt?: string;
    counts?: Record<string, number>;
    estimatedWrites?: Record<string, number>;
    conversion?: Record<string, unknown>;
    canApply?: boolean;
  };
}

export interface NotionImportConnectionResult {
  connection: NotionImportConnection;
}

export interface NotionImportOAuthBeginResult {
  authorizationUrl: string;
  state: string;
  redirectUri: string;
  expiresAt: string;
}

export async function beginNotionOAuthConnectionRemote(input: {
  workspaceId: string;
  name?: string;
  redirectUri: string;
}): Promise<NotionImportOAuthBeginResult> {
  return getClient().functions.post<NotionImportOAuthBeginResult>("notion-import", {
    action: "beginOAuthConnection",
    ...input,
  });
}

export async function completeNotionOAuthConnectionRemote(input: {
  workspaceId: string;
  code: string;
  state: string;
  redirectUri?: string;
  name?: string;
}): Promise<NotionImportConnectionResult> {
  return getClient().functions.post<NotionImportConnectionResult>("notion-import", {
    action: "completeOAuthConnection",
    ...input,
  });
}

export async function createNotionImportConnectionRemote(input: {
  workspaceId: string;
  name?: string;
  connectionKind?: NotionImportConnectionKind;
  notionToken: string;
}): Promise<NotionImportConnectionResult> {
  return getClient().functions.post<NotionImportConnectionResult>("notion-import", {
    action: "createConnection",
    ...input,
  });
}

export interface NotionImportConnectionListResult {
  connections: NotionImportConnection[];
  /** False when the backend cannot store connections (no HANJI_NOTION_IMPORT_SECRET). */
  connectionStorageAvailable?: boolean;
}

export async function listNotionImportConnectionsRemote(input: {
  workspaceId: string;
  limit?: number;
}): Promise<NotionImportConnectionListResult> {
  return getClient().functions.post<NotionImportConnectionListResult>("notion-import", {
    action: "listConnections",
    ...input,
  });
}

export async function revokeNotionImportConnectionRemote(
  connectionId: string,
  workspaceId?: string
): Promise<NotionImportConnectionResult> {
  return getClient().functions.post<NotionImportConnectionResult>("notion-import", {
    action: "revokeConnection",
    connectionId,
    workspaceId,
  });
}

export interface NotionImportRootsResult {
  roots: NotionImportRootCandidate[];
  items?: NotionImportRootScanItem[];
  scanned: number;
  searchPagesFetched: number;
  hasMore: boolean;
  nextCursor?: string | null;
  incompleteReason?: string | null;
  notionWorkspace?: {
    id?: string | null;
    name?: string | null;
  };
}

export async function listNotionImportRootsRemote(input: {
  workspaceId: string;
  parentPageId?: string | null;
  connectionId?: string;
  notionToken?: string;
  maxSearchPages?: number;
  startCursor?: string;
  includeWorkspace?: boolean;
  recordAudit?: boolean;
}): Promise<NotionImportRootsResult> {
  return getClient().functions.post<NotionImportRootsResult>("notion-import", {
    action: "listAccessibleRoots",
    ...input,
  });
}

export interface CreateNotionImportJobInput {
  workspaceId: string;
  parentPageId?: string | null;
  connectionKind?: NotionImportConnectionKind;
  connectionId?: string;
  notionToken?: string;
  rootNotionPageIds?: string[];
  rootNotionDataSourceIds?: string[];
  snapshotItems?: Array<Partial<NotionImportItem> & { notionId?: string; notionObject?: string }>;
  maxDiscoveryPages?: number;
  maxEnrichedItems?: number;
  maxChildrenPages?: number;
  maxDataSourceQueryPages?: number;
  maxViewPages?: number;
  importPagesFullWidth?: boolean;
  /** Locale for fallback names persisted by this product-created job. */
  locale?: "en" | "ko";
  // Create the job WITHOUT running discovery inline, so the client can drive
  // discovery in short chunks and keep the UI responsive on large workspaces.
  deferDiscovery?: boolean;
}

export async function createNotionImportJobRemote(
  input: CreateNotionImportJobInput
): Promise<NotionImportJobResult> {
  return getClient().functions.post<NotionImportJobResult>("notion-import", {
    action: "create",
    ...input,
  });
}

export async function listNotionImportJobsRemote(input: {
  workspaceId: string;
  limit?: number;
}): Promise<{ jobs: NotionImportJob[] }> {
  return getClient().functions.post<{ jobs: NotionImportJob[] }>("notion-import", {
    action: "list",
    ...input,
  });
}

export async function repairNotionImportPageIndexesRemote(
  workspaceId: string
): Promise<{ repaired: number; unwrapped?: number; moved?: number; trashed?: number }> {
  return getClient().functions.post<{
    repaired: number;
    unwrapped?: number;
    moved?: number;
    trashed?: number;
  }>("notion-import", {
    action: "repairPageIndexes",
    workspaceId,
  });
}

export async function getNotionImportJobRemote(jobId: string, workspaceId?: string): Promise<NotionImportJobResult> {
  return getClient().functions.post<NotionImportJobResult>("notion-import", {
    action: "get",
    jobId,
    workspaceId,
  });
}

export async function planNotionImportJobRemote(jobId: string, workspaceId?: string): Promise<NotionImportPlanResult> {
  return getClient().functions.post<NotionImportPlanResult>("notion-import", {
    action: "plan",
    jobId,
    workspaceId,
  });
}

export async function discoverNotionImportJobRemote(input: {
  jobId: string;
  workspaceId?: string;
  notionToken?: string;
  connectionId?: string;
  maxDiscoveryPages?: number;
  maxEnrichedItems?: number;
  maxChildrenPages?: number;
  maxDataSourceQueryPages?: number;
  maxViewPages?: number;
  continueFromCursor?: boolean;
  incremental?: boolean;
}): Promise<NotionImportJobResult> {
  return getClient().functions.post<NotionImportJobResult>("notion-import", {
    action: "discover",
    ...input,
  });
}

export async function cancelNotionImportJobRemote(jobId: string, workspaceId?: string): Promise<NotionImportJobResult> {
  return getClient().functions.post<NotionImportJobResult>("notion-import", {
    action: "cancel",
    jobId,
    workspaceId,
  });
}

export interface ApplyNotionImportJobInput {
  jobId: string;
  workspaceId?: string;
  notionToken?: string;
  connectionId?: string;
  importPagesFullWidth?: boolean;
  applyPageBatchSize?: number;
  applyDatabaseBatchSize?: number;
}

export interface NotionImportAppliedMapping {
  notionId?: string;
  localId?: string | null;
  localType?: string | null;
}

export async function applyNotionImportJobRemote(input: string | ApplyNotionImportJobInput): Promise<NotionImportJobResult & {
  applied?: Record<string, number>;
  mappings?: NotionImportAppliedMapping[];
  partial?: boolean;
}> {
  const body = typeof input === "string" ? { jobId: input } : input;
  return getClient().functions.post<NotionImportJobResult & {
    applied?: Record<string, number>;
    mappings?: NotionImportAppliedMapping[];
    partial?: boolean;
  }>("notion-import", {
    action: "apply",
    ...body,
  });
}

export async function retryNotionImportFileCopiesRemote(jobId: string, workspaceId?: string): Promise<NotionImportJobResult & {
  fileRetry?: Record<string, unknown>;
}> {
  return getClient().functions.post<NotionImportJobResult & { fileRetry?: Record<string, unknown> }>("notion-import", {
    action: "retryFileCopies",
    jobId,
    workspaceId,
  });
}

export async function retryNotionImportJobRemote(input: {
  jobId: string;
  workspaceId?: string;
  notionToken?: string;
  connectionId?: string;
  maxDiscoveryPages?: number;
  maxEnrichedItems?: number;
  maxChildrenPages?: number;
  maxDataSourceQueryPages?: number;
  maxViewPages?: number;
  importPagesFullWidth?: boolean;
  deferDiscovery?: boolean;
  locale?: "en" | "ko";
}): Promise<NotionImportJobResult> {
  return getClient().functions.post<NotionImportJobResult>("notion-import", {
    action: "retry",
    ...input,
  });
}

export interface WorkspaceMembersResult {
  workspace: Workspace;
  organization?: Organization | null;
  organizations?: Organization[];
  currentOrganizationMember?: OrganizationMember | null;
  organizationMembers?: OrganizationMember[];
  organizationGroups?: OrganizationGroup[];
  organizationProfiles?: OrganizationProfile[];
  organizationDomains?: OrganizationDomain[];
  organizationAuditEvents?: OrganizationAuditEvent[];
  enterpriseControls?: OrganizationEnterpriseControls;
  organizationScimTokens?: OrganizationScimToken[];
  organizationLegalHolds?: OrganizationLegalHold[];
  organizationAuditExports?: OrganizationAuditExport[];
  organizationBillingRecords?: OrganizationBillingRecord[];
  workspaces?: Workspace[];
  currentMember?: WorkspaceMember;
  member?: WorkspaceMember;
  members: WorkspaceMember[];
  invitation?: WorkspaceInvitation;
  acceptedInvitationId?: string;
  invitations?: WorkspaceInvitation[];
  deletedId?: string;
  deletedInvitationId?: string;
  instanceSettings?: InstanceSettings;
}

export interface OrganizationDirectoryResult {
  organization: Organization;
  instanceSettings?: InstanceSettings;
  currentOrganizationMember?: OrganizationMember | null;
  organizationMembers: OrganizationMember[];
  organizationGroups?: OrganizationGroup[];
  organizationProfiles?: OrganizationProfile[];
  organizationDomains?: OrganizationDomain[];
  organizationAuditEvents?: OrganizationAuditEvent[];
  enterpriseControls?: OrganizationEnterpriseControls;
  organizationScimTokens?: OrganizationScimToken[];
  organizationLegalHolds?: OrganizationLegalHold[];
  organizationAuditExports?: OrganizationAuditExport[];
  organizationBillingRecords?: OrganizationBillingRecord[];
  organizationAuditFilter?: {
    action?: string | null;
    targetType?: string | null;
    limit?: number;
  } | null;
  workspaces?: Workspace[];
}

export interface OrganizationDirectoryInput {
  organizationId: string;
  auditAction?: string | null;
  auditTargetType?: string | null;
  auditLimit?: number;
}

export interface SearchOrganizationPeopleInput {
  organizationId: string;
  query?: string;
  limit?: number;
  includeInvited?: boolean;
  includeDeactivated?: boolean;
}

export interface SearchOrganizationPeopleResult {
  organization?: Organization;
  currentOrganizationMember?: OrganizationMember | null;
  query?: string;
  limit?: number;
  people: OrganizationProfile[];
}

export interface UpdateOrganizationSettingsInput {
  organizationId: string;
  workspaceCreationPolicy?: WorkspaceCreationPolicy;
  signupPolicy?: SignupPolicy;
  domainSignupPolicy?: DomainSignupPolicy;
  sharingPolicy?: OrganizationSharingPolicy;
  storageLimitBytes?: number | null;
}

export interface UpdateOrganizationEnterpriseControlsInput {
  organizationId: string;
  ssoConfig?: Record<string, unknown>;
  scimConfig?: Record<string, unknown>;
  auditPolicy?: Record<string, unknown>;
  dataResidencyPolicy?: Record<string, unknown>;
  dlpPolicy?: Record<string, unknown>;
  legalPolicy?: Record<string, unknown>;
  billingProfile?: Record<string, unknown>;
}

export interface InstanceAdminResult {
  instanceSettings: InstanceSettings;
  instanceAdmins: string[];
  users: InstanceAdminUser[];
  overview: ServerOverviewSummary;
  workspaces: ServerWorkspaceSummary[];
  security: ServerSecuritySummary;
  auditEvents: ServerAuditSummaryEvent[];
  importJobs: ServerImportJobSummary[];
  usage: ServerUsageSummary;
  backup: ServerBackupSummary;
  system: ServerSystemSummary;
  temporaryPassword?: string;
  cursor?: string;
}

export interface InstanceAdminInput {
  limit?: number;
  cursor?: string;
}

export async function getInstanceAdminRemote(
  input: InstanceAdminInput = {},
): Promise<InstanceAdminResult> {
  return getClient().functions.post<InstanceAdminResult>("instance-admin", {
    action: "get",
    ...input,
  });
}

export async function updateInstanceSignupPolicyRemote(
  signupPolicy: SignupPolicy,
): Promise<InstanceAdminResult> {
  return getClient().functions.post<InstanceAdminResult>("instance-admin", {
    action: "updateSignupPolicy",
    signupPolicy,
  });
}

export async function setInstanceUserDisabledRemote(
  userId: string,
  disabled: boolean,
): Promise<InstanceAdminResult> {
  return getClient().functions.post<InstanceAdminResult>("instance-admin", {
    action: "setUserDisabled",
    userId,
    disabled,
  });
}

export async function deleteInstanceUserRemote(userId: string): Promise<InstanceAdminResult> {
  return getClient().functions.post<InstanceAdminResult>("instance-admin", {
    action: "deleteUser",
    userId,
  });
}

export async function setInstanceAdminRemote(
  userId: string,
  enabled: boolean,
): Promise<InstanceAdminResult> {
  return getClient().functions.post<InstanceAdminResult>("instance-admin", {
    action: "setInstanceAdmin",
    userId,
    enabled,
  });
}

export async function createInstanceUserRemote(input: {
  email: string;
  displayName?: string;
  password?: string;
}): Promise<InstanceAdminResult> {
  return getClient().functions.post<InstanceAdminResult>("instance-admin", {
    action: "createUser",
    ...input,
  });
}

export async function resetInstanceUserPasswordRemote(
  userId: string,
  password?: string,
): Promise<InstanceAdminResult> {
  return getClient().functions.post<InstanceAdminResult>("instance-admin", {
    action: "resetUserPassword",
    userId,
    ...(password ? { password } : {}),
  });
}

export async function revokeInstanceUserSessionsRemote(userId: string): Promise<InstanceAdminResult> {
  return getClient().functions.post<InstanceAdminResult>("instance-admin", {
    action: "revokeUserSessions",
    userId,
  });
}

export async function createInstanceBackupSnapshotRemote(): Promise<InstanceBackupSnapshot> {
  const result = await getClient().functions.post<{ snapshot: InstanceBackupSnapshot }>("instance-admin", {
    action: "createBackupSnapshot",
  });
  return result.snapshot;
}

export interface ServerUserSummary {
  id: string;
  email: string | null;
  displayName: string | null;
}

/**
 * Search the server account directory by name or email (instance-admins only).
 * Powers the workspace member-add picker; non-admins get a 403 and add members
 * by typing an exact email instead.
 */
export async function searchServerUsersRemote(
  query: string,
  limit = 10,
): Promise<ServerUserSummary[]> {
  const result = await getClient().functions.post<{ users?: ServerUserSummary[] }>("instance-admin", {
    action: "searchUsers",
    query,
    limit,
  });
  return Array.isArray(result?.users) ? result.users : [];
}

export async function getOrganizationDirectoryRemote(
  input: string | OrganizationDirectoryInput
): Promise<OrganizationDirectoryResult> {
  const body = typeof input === "string" ? { organizationId: input } : input;
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "organizationDirectory",
    ...body,
  });
}

export async function searchOrganizationPeopleRemote(
  input: SearchOrganizationPeopleInput
): Promise<SearchOrganizationPeopleResult> {
  return getClient().functions.post<SearchOrganizationPeopleResult>("workspace-mutation", {
    action: "searchOrganizationPeople",
    ...input,
  });
}

export async function updateOrganizationSettingsRemote(
  input: UpdateOrganizationSettingsInput
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "updateOrganizationSettings",
    ...input,
  });
}

export async function updateOrganizationEnterpriseControlsRemote(
  input: UpdateOrganizationEnterpriseControlsInput
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "updateOrganizationEnterpriseControls",
    ...input,
  });
}

export async function createOrganizationScimTokenRemote(input: {
  organizationId: string;
  label?: string;
  expiresAt?: string | null;
}): Promise<OrganizationDirectoryResult & {
  scimToken?: OrganizationScimToken;
  scimTokenSecret?: string;
}> {
  return getClient().functions.post<OrganizationDirectoryResult & {
    scimToken?: OrganizationScimToken;
    scimTokenSecret?: string;
  }>("workspace-mutation", {
    action: "createOrganizationScimToken",
    ...input,
  });
}

export async function revokeOrganizationScimTokenRemote(input: {
  organizationId: string;
  scimTokenId: string;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "revokeOrganizationScimToken",
    ...input,
  });
}

export async function createOrganizationLegalHoldRemote(input: {
  organizationId: string;
  name: string;
  reason?: string | null;
  scope?: Record<string, unknown>;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "createOrganizationLegalHold",
    ...input,
  });
}

export async function releaseOrganizationLegalHoldRemote(input: {
  organizationId: string;
  legalHoldId: string;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "releaseOrganizationLegalHold",
    ...input,
  });
}

export async function exportOrganizationAuditEventsRemote(input: {
  organizationId: string;
  format?: "jsonl" | "csv" | "json";
  auditAction?: string | null;
  auditTargetType?: string | null;
  auditLimit?: number;
  since?: string | null;
  until?: string | null;
}): Promise<OrganizationDirectoryResult & {
  auditExport?: OrganizationAuditExport;
  auditExportContent?: string;
}> {
  return getClient().functions.post<OrganizationDirectoryResult & {
    auditExport?: OrganizationAuditExport;
    auditExportContent?: string;
  }>("workspace-mutation", {
    action: "exportOrganizationAuditEvents",
    ...input,
  });
}

export async function upsertOrganizationBillingRecordRemote(input: {
  organizationId: string;
  billingRecordId?: string;
  kind?: OrganizationBillingRecord["kind"];
  status?: string;
  title: string;
  amountCents?: number | null;
  currency?: string | null;
  billingEmail?: string | null;
  contractOwnerEmail?: string | null;
  renewalAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "upsertOrganizationBillingRecord",
    ...input,
  });
}

export async function deleteOrganizationBillingRecordRemote(input: {
  organizationId: string;
  billingRecordId: string;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "deleteOrganizationBillingRecord",
    ...input,
  });
}

export async function updateOrganizationMemberRoleRemote(
  organizationId: string,
  organizationMemberId: string,
  role: Exclude<OrganizationMemberRole, "owner">
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "updateOrganizationMemberRole",
    organizationId,
    organizationMemberId,
    role,
  });
}

export async function createOrganizationGroupRemote(input: {
  organizationId: string;
  name: string;
  description?: string | null;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "createOrganizationGroup",
    ...input,
  });
}

export async function updateOrganizationGroupRemote(input: {
  organizationId: string;
  organizationGroupId: string;
  name?: string;
  description?: string | null;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "updateOrganizationGroup",
    ...input,
  });
}

export async function deleteOrganizationGroupRemote(input: {
  organizationId: string;
  organizationGroupId: string;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "deleteOrganizationGroup",
    ...input,
  });
}

export async function addOrganizationGroupMemberRemote(input: {
  organizationId: string;
  organizationGroupId: string;
  organizationMemberId: string;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "addOrganizationGroupMember",
    ...input,
  });
}

export async function removeOrganizationGroupMemberRemote(input: {
  organizationId: string;
  organizationGroupId: string;
  organizationGroupMemberId: string;
}): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "removeOrganizationGroupMember",
    ...input,
  });
}

export async function transferOrganizationOwnerRemote(
  organizationId: string,
  organizationMemberId: string
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "transferOrganizationOwner",
    organizationId,
    organizationMemberId,
  });
}

export async function deactivateOrganizationMemberRemote(
  organizationId: string,
  organizationMemberId: string
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "deactivateOrganizationMember",
    organizationId,
    organizationMemberId,
  });
}

export async function reactivateOrganizationMemberRemote(
  organizationId: string,
  organizationMemberId: string
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "reactivateOrganizationMember",
    organizationId,
    organizationMemberId,
  });
}

export async function removeOrganizationMemberRemote(
  organizationId: string,
  organizationMemberId: string,
  options: { reassignToOrganizationMemberId?: string; reassignToUserId?: string } = {}
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "removeOrganizationMember",
    organizationId,
    organizationMemberId,
    ...options,
  });
}

export async function addOrganizationDomainRemote(
  organizationId: string,
  domain: string
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "addOrganizationDomain",
    organizationId,
    domain,
  });
}

export async function verifyOrganizationDomainRemote(
  organizationId: string,
  organizationDomainId: string
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "verifyOrganizationDomain",
    organizationId,
    organizationDomainId,
  });
}

export async function removeOrganizationDomainRemote(
  organizationId: string,
  organizationDomainId: string
): Promise<OrganizationDirectoryResult> {
  return getClient().functions.post<OrganizationDirectoryResult>("workspace-mutation", {
    action: "removeOrganizationDomain",
    organizationId,
    organizationDomainId,
  });
}

export interface CollaborationOperationRecord {
  id: string;
  workspaceId: string;
  pageId: string;
  blockId?: string | null;
  clientId: string;
  kind: string;
  operation?: CollaborationOperationPayload;
  beforeText?: string;
  afterText?: string;
  revision?: number;
  actorId?: string;
  occurredAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CollaborationDocumentRecord {
  id: string;
  workspaceId: string;
  pageId: string;
  blockId?: string | null;
  documentId: string;
  engine: string;
  schemaVersion?: number;
  stateBase64: string;
  stateVectorBase64?: string;
  updateCount?: number;
  lastOperationId?: string | null;
  lastOperationRevision?: number;
  lastOperationOccurredAt?: string | null;
  checkpointedAt?: string;
  createdAt?: string;
  updatedAt: string;
}

export interface InviteWorkspaceMemberInput {
  workspaceId: string;
  userId?: string;
  email?: string | null;
  displayName?: string | null;
  role?: WorkspaceMember["role"];
}

export interface UpdateMyWorkspaceProfileInput {
  workspaceId: string;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
}

export interface UpdateWorkspaceMemberRoleInput {
  workspaceId: string;
  memberId?: string;
  userId?: string;
  role: WorkspaceMember["role"];
}

export interface TransferWorkspaceOwnerInput {
  workspaceId: string;
  memberId?: string;
  userId?: string;
}

export interface RemoveWorkspaceMemberInput {
  workspaceId: string;
  memberId?: string;
  userId?: string;
}

export async function getWorkspaceMembersRemote(
  workspaceId: string
): Promise<WorkspaceMembersResult> {
  return getClient().functions.post<WorkspaceMembersResult>("workspace-mutation", {
    action: "members",
    workspaceId,
  });
}

// Add a workspace member. `userId` is the admin picker path (an exact server
// account); `email` is resolved server-side to an existing account, or is a
// blind no-op when no account matches. No invitation email is ever sent.
export async function addWorkspaceMemberRemote(
  input: InviteWorkspaceMemberInput
): Promise<WorkspaceMembersResult> {
  return getClient().functions.post<WorkspaceMembersResult>("workspace-mutation", {
    action: "addMember",
    ...input,
  });
}

export async function updateMyWorkspaceProfileRemote(
  input: UpdateMyWorkspaceProfileInput
): Promise<WorkspaceMembersResult> {
  return getClient().functions.post<WorkspaceMembersResult>("workspace-mutation", {
    action: "updateMyProfile",
    ...input,
  });
}

export async function updateWorkspaceMemberRoleRemote(
  input: UpdateWorkspaceMemberRoleInput
): Promise<WorkspaceMembersResult> {
  return getClient().functions.post<WorkspaceMembersResult>("workspace-mutation", {
    action: "updateMemberRole",
    ...input,
  });
}

export async function transferWorkspaceOwnerRemote(
  input: TransferWorkspaceOwnerInput
): Promise<WorkspaceMembersResult> {
  return getClient().functions.post<WorkspaceMembersResult>("workspace-mutation", {
    action: "transferWorkspaceOwner",
    ...input,
  });
}

export async function removeWorkspaceMemberRemote(
  input: RemoveWorkspaceMemberInput
): Promise<WorkspaceMembersResult> {
  return getClient().functions.post<WorkspaceMembersResult>("workspace-mutation", {
    action: "removeMember",
    ...input,
  });
}

export interface PageMutationPagesResult {
  pages: Page[];
}

export interface PageMutationDeleteResult {
  deletedIds: string[];
}

export interface DuplicatePageResult {
  page: Page | null;
  source?: Page;
  parentId: string | null;
  parentType: Page["parentType"];
  pages: Page[];
  blocks: Block[];
  properties: DbProperty[];
  views: DbView[];
  templates: DbTemplate[];
  counts: {
    pages: number;
    blocks: number;
    properties: number;
    views: number;
    templates: number;
  };
}

export async function createPageRemote(page: Page): Promise<Page> {
  const result = await callInteractiveMutation<{ page: Page }>("page-mutation", {
    action: "create",
    ...page,
  });
  return result.page;
}

export async function updatePageRemote(id: string, patch: Partial<Page>): Promise<Page> {
  const result = await callInteractiveMutation<{ page: Page }>("page-mutation", {
    action: "update",
    id,
    patch,
  });
  return result.page;
}

export async function trashPageRemote(id: string): Promise<Page[]> {
  const result = await callInteractiveMutation<PageMutationPagesResult>("page-mutation", {
    action: "trash",
    id,
  });
  return result.pages;
}

export async function restorePageRemote(id: string): Promise<Page[]> {
  const result = await callInteractiveMutation<PageMutationPagesResult>("page-mutation", {
    action: "restore",
    id,
  });
  return result.pages;
}

export async function deletePageRemote(id: string, workspaceId?: string): Promise<string[]> {
  const result = await callInteractiveMutation<PageMutationDeleteResult>("page-mutation", {
    action: "delete",
    id,
    workspaceId,
  });
  return result.deletedIds;
}

export async function duplicatePageRemote(
  id: string,
  options: { locale?: "en" | "ko"; title?: string } = {},
): Promise<DuplicatePageResult> {
  return getClient().functions.post<DuplicatePageResult>("duplicate-page", {
    action: "duplicate",
    pageId: id,
    ...options,
  });
}

export interface PageAccessResult {
  page: Page;
  shareLink: ShareLink | null;
  permissions: PagePermission[];
  canManage?: boolean;
  permission?: PagePermission;
  deletedId?: string;
  warnings?: string[];
}

export interface SharedPageResult {
  page: Page;
  pages: Page[];
  blocks: Block[];
  properties: DbProperty[];
  views: DbView[];
  templates: DbTemplate[];
  navigablePageIds?: string[];
  shareLink: Pick<ShareLink, "enabled" | "role" | "expiresAt">;
  snapshotVersion?: string;
}

export interface PageBlocksResult {
  pageId: string;
  blocks: Block[];
}

export interface BlocksResult {
  blocks: Block[];
}

export interface PageCommentsResult {
  pageId: string;
  comments: Comment[];
}

export interface DatabaseSnapshotResult {
  databaseId: string;
  resolvedDatabaseId?: string;
  resolvedFromNotionDatabaseId?: string;
  resolvedDatabaseTitle?: string;
  properties: DbProperty[];
  views: DbView[];
  templates: DbTemplate[];
}

export interface DatabaseRowsResult {
  databaseId: string;
  rows: Page[];
  relatedPages?: Page[];
  relationTargetIds?: string[];
  computed?: Record<string, Record<string, ComputedPropertyValue>>;
  offset?: number;
  limit?: number;
  totalCount?: number;
  hasMore?: boolean;
  nextOffset?: number;
}

export interface ImportMarkdownPageInput {
  workspaceId: string;
  parentId?: string | null;
  parentType?: PageParentType;
  title?: string;
  markdown: string;
  position?: number;
}

export interface ImportMarkdownPageResult {
  page: Page;
  blocks: Block[];
  count: number;
}

export interface AppendMarkdownToPageInput {
  pageId: string;
  markdown: string;
}

export interface AppendMarkdownToPageResult {
  page: Page;
  blocks: Block[];
  count: number;
}

export interface ImportCsvDatabaseInput {
  workspaceId: string;
  parentId?: string | null;
  parentType?: PageParentType;
  title?: string;
  csv: string;
  position?: number;
  /** Locale for generated missing headers and the initial table view. */
  locale?: "en" | "ko";
}

export interface ImportCsvDatabaseResult {
  page: Page;
  properties: DbProperty[];
  view: DbView;
  rows: Page[];
  count: number;
}

export interface UrlMetadata {
  url: string;
  title: string;
  iconUrl?: string;
  siteName?: string;
  description?: string;
}

export async function getPageBlocksRemote(pageId: string): Promise<PageBlocksResult> {
  return getClient().functions.post<PageBlocksResult>("page-query", {
    action: "blocks",
    pageId,
  });
}

export async function getPageRemote(pageId: string): Promise<Page> {
  const result = await getClient().functions.post<{ page: Page }>("page-query", {
    action: "page",
    pageId,
  });
  return result.page;
}

export async function getAllBlocksRemote(): Promise<BlocksResult> {
  return getClient().functions.post<BlocksResult>("page-query", {
    action: "allBlocks",
  });
}

export async function searchBlocksRemote(query: string, limit = 20): Promise<BlocksResult> {
  return getClient().functions.post<BlocksResult>("page-query", {
    action: "searchBlocks",
    query,
    limit,
  });
}

export async function getPageCommentsRemote(pageId: string): Promise<PageCommentsResult> {
  return getClient().functions.post<PageCommentsResult>("page-query", {
    action: "comments",
    pageId,
  });
}

export async function getDatabaseSnapshotRemote(
  databaseId: string,
  opts: { viewIds?: string[] } = {}
): Promise<DatabaseSnapshotResult> {
  return getClient().functions.post<DatabaseSnapshotResult>("page-query", {
    action: "database",
    databaseId,
    ...(opts.viewIds?.length ? { viewIds: opts.viewIds } : {}),
  });
}

export async function getDatabaseRowsRemote(
  databaseId: string,
  opts: {
    includeComputed?: boolean;
    includeRelationTargets?: boolean;
    includeTrash?: boolean;
    limit?: number;
    offset?: number;
    viewId?: string;
    search?: string;
    currentPageId?: string;
  } = {}
): Promise<DatabaseRowsResult> {
  const result = await getClient().functions.post<DatabaseRowsResult>("page-query", {
    action: "databaseRows",
    databaseId,
    ...opts,
  });
  const computed = result.computed ?? {};
  return {
    ...result,
    rows: (result.rows ?? []).map((row) =>
      computed[row.id] ? { ...row, __computed: computed[row.id] } : row
    ),
  };
}

export async function importMarkdownPageRemote(
  input: ImportMarkdownPageInput
): Promise<ImportMarkdownPageResult> {
  return getClient().functions.post<ImportMarkdownPageResult>("import-export", {
    action: "importMarkdownPage",
    ...input,
  });
}

export async function appendMarkdownToPageRemote(
  input: AppendMarkdownToPageInput
): Promise<AppendMarkdownToPageResult> {
  return getClient().functions.post<AppendMarkdownToPageResult>("import-export", {
    action: "appendMarkdownToPage",
    ...input,
  });
}

export async function importCsvDatabaseRemote(
  input: ImportCsvDatabaseInput
): Promise<ImportCsvDatabaseResult> {
  return getClient().functions.post<ImportCsvDatabaseResult>("import-export", {
    action: "importCsvDatabase",
    ...input,
  });
}

// ─── Native Hanji export/import (.hanji.json) ────────────────────────────

export interface NativeExportWarning {
  code: string;
  entityId?: string;
  detail?: string;
}

export interface HanjiExportDocument {
  format: string;
  formatVersion: number;
  generatedAt?: string;
  app?: { name: string; version?: string };
  scope?: { kind: "workspace" | "subtree"; rootIds: string[] };
  source?: { workspaceId: string; workspaceName?: string; workspaceIcon?: string };
  counts?: Record<string, number>;
  files?: { included: false; strippedReferences: number };
  entities: {
    pages: unknown[];
    blocks?: unknown[];
    dbProperties?: unknown[];
    dbViews?: unknown[];
    dbTemplates?: unknown[];
    comments?: unknown[];
  };
  relationPairs?: unknown[];
  warnings?: NativeExportWarning[];
}

export interface ExportNativeResult {
  document: HanjiExportDocument;
  counts: Record<string, number>;
  warnings: NativeExportWarning[];
}

export interface ImportNativeInput {
  workspaceId: string;
  parentId?: string | null;
  parentType?: PageParentType;
  document: HanjiExportDocument;
}

export interface ImportNativeResult {
  rootPageIds: string[];
  counts: Record<string, number>;
  warnings: NativeExportWarning[];
}

export async function exportWorkspaceNativeRemote(
  workspaceId: string
): Promise<ExportNativeResult & { workspace?: { id: string; name?: string } }> {
  return getClient().functions.post("import-export", {
    action: "exportWorkspaceNative",
    workspaceId,
  });
}

export async function exportPageNativeRemote(
  pageId: string
): Promise<ExportNativeResult & { page?: { id: string; title?: string; kind?: string } }> {
  return getClient().functions.post("import-export", {
    action: "exportPageNative",
    pageId,
  });
}

export async function importNativeRemote(input: ImportNativeInput): Promise<ImportNativeResult> {
  return getClient().functions.post<ImportNativeResult>("import-export", {
    action: "importNative",
    ...input,
  });
}

export async function fetchUrlMetadataRemote(url: string): Promise<UrlMetadata> {
  const result = await getClient().functions.post<{ metadata: UrlMetadata }>("url-metadata", {
    url,
  });
  return result.metadata;
}

export interface PrepareFileUploadInput {
  workspaceId?: string;
  scope?: string;
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  name: string;
  size: number;
  contentType?: string;
}

export interface PreparedFileUploadResult {
  upload: FileUpload;
  uploadUrl?: string;
  uploadExpiresAt?: string;
  uploadMaxBytes?: number | null;
}

export interface CompleteFileUploadInput {
  id: string;
  key: string;
  url: string;
}

export interface ListFileUploadsInput {
  workspaceId?: string;
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  scope?: string;
  status?: FileUpload["status"];
  includeDeleted?: boolean;
}

export interface DeleteFileUploadInput {
  id?: string;
  uploadId?: string;
  key?: string;
}

export interface FileDownloadUrlInput extends DeleteFileUploadInput {
  expiresIn?: string;
}

export interface CleanupExpiredFileUploadsInput {
  workspaceId?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface CleanupExpiredFileUploadsResult {
  workspaceId: string;
  dryRun: boolean;
  scanned: number;
  expired: FileUpload[];
}

export interface FileUsageReportInput {
  workspaceId?: string;
  organizationId?: string;
  maintenanceLimit?: number;
}

export interface NotificationActivityInput {
  activityKey: string;
  kind: NotificationKind;
  pageId?: string | null;
  blockId?: string | null;
  commentId?: string | null;
  actorId?: string | null;
  title?: string;
  preview?: string;
  target?: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;
}

export interface NotificationMutationResult {
  workspaceId: string;
  notifications: NotificationRecord[];
  synced?: NotificationRecord[];
  updated?: NotificationRecord[];
  unreadCount: number;
  total: number;
}

export interface ListNotificationsInput {
  workspaceId: string;
  includeRead?: boolean;
  kind?: NotificationKind;
  limit?: number;
}

export async function prepareFileUploadRemote(
  input: PrepareFileUploadInput
): Promise<PreparedFileUploadResult> {
  return getClient().functions.post<PreparedFileUploadResult>("file-mutation", {
    action: "prepareUpload",
    ...input,
  });
}

export async function completeFileUploadRemote(input: CompleteFileUploadInput): Promise<FileUpload> {
  const result = await getClient().functions.post<{ upload: FileUpload }>("file-mutation", {
    action: "completeUpload",
    ...input,
  });
  return result.upload;
}

export async function listFileUploadsRemote(input: ListFileUploadsInput = {}): Promise<FileUpload[]> {
  const result = await getClient().functions.post<{ uploads: FileUpload[] }>("file-mutation", {
    action: "list",
    ...input,
  });
  return result.uploads ?? [];
}

export async function deleteFileUploadRemote(input: DeleteFileUploadInput): Promise<FileUpload> {
  const result = await getClient().functions.post<{ upload: FileUpload }>("file-mutation", {
    action: "delete",
    ...input,
  });
  return result.upload;
}

export async function createFileDownloadUrlRemote(
  input: FileDownloadUrlInput
): Promise<{ upload: FileUpload; url: string; expiresAt: string }> {
  return getClient().functions.post<{ upload: FileUpload; url: string; expiresAt: string }>(
    "file-mutation",
    {
      action: "signedUrl",
      ...input,
    }
  );
}

export async function cleanupExpiredFileUploadsRemote(
  input: CleanupExpiredFileUploadsInput = {}
): Promise<CleanupExpiredFileUploadsResult> {
  return getClient().functions.post<CleanupExpiredFileUploadsResult>("file-mutation", {
    action: "cleanupExpired",
    ...input,
  });
}

export async function getFileUsageReportRemote(
  input: FileUsageReportInput = {}
): Promise<FileUsageReport> {
  return getClient().functions.post<FileUsageReport>("file-mutation", {
    action: input.organizationId ? "organizationReport" : "report",
    ...input,
  });
}

export async function listNotificationsRemote(
  input: ListNotificationsInput
): Promise<NotificationMutationResult> {
  return getClient().functions.post<NotificationMutationResult>("notification-mutation", {
    action: "list",
    ...input,
  });
}

export async function syncNotificationsRemote(
  workspaceId: string,
  activities: NotificationActivityInput[]
): Promise<NotificationMutationResult> {
  return getClient().functions.post<NotificationMutationResult>("notification-mutation", {
    action: "sync",
    workspaceId,
    activities,
  });
}

export async function markNotificationsReadRemote(
  workspaceId: string,
  activityKeys: string[]
): Promise<NotificationMutationResult> {
  return getClient().functions.post<NotificationMutationResult>("notification-mutation", {
    action: "markRead",
    workspaceId,
    activityKeys,
  });
}

export async function markAllNotificationsReadRemote(
  workspaceId: string
): Promise<NotificationMutationResult> {
  return getClient().functions.post<NotificationMutationResult>("notification-mutation", {
    action: "markAllRead",
    workspaceId,
  });
}

export async function getPageAccessRemote(pageId: string): Promise<PageAccessResult> {
  return getClient().functions.post<PageAccessResult>("share-mutation", {
    action: "get",
    pageId,
  });
}

export async function getSharedPageRemote(token: string): Promise<SharedPageResult> {
  const cacheKey = `hanji:public-share-snapshot:${token}`;
  let cached: { cachedAt: number; snapshot: SharedPageResult } | undefined;
  try {
    const raw = window.sessionStorage.getItem(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw) as typeof cached;
      if (parsed?.snapshot?.page?.id && typeof parsed.cachedAt === "number") cached = parsed;
    }
  } catch {
    // Storage is an optimization only; public authorization remains remote.
  }
  // Signed file URLs last 15 minutes. Only reuse a confirmed snapshot inside
  // a shorter window so its capabilities cannot expire underneath the page.
  const reusable = cached && Date.now() - cached.cachedAt < 5 * 60_000 ? cached : undefined;
  type ConditionalSharedPageResult =
    | SharedPageResult
    | { notModified: true; snapshotVersion: string };
  let result = await getClient().functions.post<ConditionalSharedPageResult>("share-mutation", {
    action: "publicPage",
    token,
    ...(reusable?.snapshot.snapshotVersion
      ? { snapshotVersion: reusable.snapshot.snapshotVersion }
      : {}),
  });
  if ("notModified" in result) {
    if (reusable) return reusable.snapshot;
    // A storage race removed the local body after the conditional request.
    // Retry unconditionally instead of rendering an incomplete snapshot.
    result = await getClient().functions.post<SharedPageResult>("share-mutation", {
      action: "publicPage",
      token,
    });
  }
  if (result.snapshotVersion) {
    try {
      window.sessionStorage.setItem(
        cacheKey,
        JSON.stringify({ cachedAt: Date.now(), snapshot: result })
      );
    } catch {
      // Quota/privacy mode does not affect correctness.
    }
  }
  return result;
}

export async function setPageWebSharingRemote(
  pageId: string,
  enabled: boolean,
  expiresAt?: string | null
): Promise<PageAccessResult> {
  return getClient().functions.post<PageAccessResult>("share-mutation", {
    action: "setWebSharing",
    pageId,
    enabled,
    expiresAt,
  });
}

export async function invitePageAccessRemote(
  pageId: string,
  label: string,
  role: ShareRole,
  principalType: SharePrincipalType = "email",
  principalId?: string
): Promise<PageAccessResult> {
  return getClient().functions.post<PageAccessResult>("share-mutation", {
    action: "invite",
    pageId,
    label,
    role,
    principalType,
    principalId,
  });
}

export async function updatePagePermissionRemote(
  permissionId: string,
  role: ShareRole
): Promise<PageAccessResult> {
  return getClient().functions.post<PageAccessResult>("share-mutation", {
    action: "updatePermission",
    permissionId,
    role,
  });
}

export async function removePagePermissionRemote(permissionId: string): Promise<PageAccessResult> {
  return getClient().functions.post<PageAccessResult>("share-mutation", {
    action: "removePermission",
    permissionId,
  });
}

export async function createBlockRemote(block: Block): Promise<Block> {
  const result = await callInteractiveMutation<{ block: Block }>("block-mutation", {
    action: "create",
    ...block,
  });
  return result.block;
}

export async function createBlocksRemote(blocks: Block[]): Promise<Block[]> {
  const result = await callInteractiveMutation<{ blocks: Block[] }>("block-mutation", {
    action: "createMany",
    blocks,
  });
  return result.blocks;
}

export async function updateBlockRemote(
  id: string,
  patch: Partial<Block>,
  pageId?: string,
  expectedUpdatedAt?: string
): Promise<Block> {
  const result = await callInteractiveMutation<{ block: Block }>("block-mutation", {
    action: "update",
    id,
    patch,
    // Routing hint for the workspace-DO split; harmless before the flip.
    pageId,
    // Optimistic-concurrency guard: the server 409s when the block changed
    // since this stamp. Only sent on offline-outbox replay (see store.ts).
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
  });
  return result.block;
}

export async function updateBlocksRemote(
  updates: Array<{ id: string; patch: Partial<Block> }>,
  pageId?: string
): Promise<Block[]> {
  const result = await callInteractiveMutation<{ blocks: Block[] }>("block-mutation", {
    action: "updateMany",
    updates,
    pageId,
  });
  return result.blocks;
}

export async function deleteBlockRemote(id: string, pageId?: string): Promise<string[]> {
  const result = await callInteractiveMutation<{ deletedIds: string[] }>("block-mutation", {
    action: "delete",
    id,
    pageId,
  });
  return result.deletedIds;
}

export async function deleteBlocksRemote(ids: string[], pageId?: string): Promise<string[]> {
  const result = await callInteractiveMutation<{ deletedIds: string[] }>("block-mutation", {
    action: "deleteMany",
    ids,
    pageId,
  });
  return result.deletedIds;
}

export async function recordCollaborationOperationRemote(input: {
  afterText?: string;
  beforeText?: string;
  blockId?: string | null;
  kind?: string;
  operation?: CollaborationOperationPayload;
  pageId: string;
  revision?: number;
  occurredAt?: string;
}): Promise<CollaborationOperationRecord> {
  const result = await getClient().functions.post<{ operation: CollaborationOperationRecord }>(
    "collaboration-mutation",
    {
      action: "create",
      ...input,
      clientId: browserClientId(),
      kind: input.kind ?? "text",
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    },
  );
  return result.operation;
}

export async function listCollaborationOperationsRemote(input: {
  afterId?: string;
  afterOccurredAt?: string;
  afterRevision?: number;
  limit?: number;
  pageId: string;
}): Promise<CollaborationOperationRecord[]> {
  const result = await getClient().functions.post<{ operations: CollaborationOperationRecord[] }>(
    "collaboration-mutation",
    {
      action: "list",
      ...input,
    },
  );
  return result.operations ?? [];
}

export async function listCollaborationDocumentsRemote(input: {
  blockIds?: string[];
  documentIds?: string[];
  limit?: number;
  pageId: string;
  repair?: true | "auto";
  repairMode?: "auto" | "full";
}): Promise<CollaborationDocumentRecord[]> {
  const result = await getClient().functions.post<{ documents: CollaborationDocumentRecord[] }>(
    "collaboration-mutation",
    {
      action: "documents",
      ...input,
    },
  );
  return result.documents ?? [];
}

export async function createCommentRemote(comment: Comment): Promise<Comment> {
  const result = await getClient().functions.post<{ comment: Comment }>("comment-mutation", {
    action: "create",
    ...comment,
  });
  return result.comment;
}

export async function updateCommentRemote(
  id: string,
  patch: Partial<Comment>,
  pageId?: string
): Promise<Comment> {
  const result = await getClient().functions.post<{ comment: Comment }>("comment-mutation", {
    action: "update",
    id,
    patch,
    // Top-level routing hint for the workspace-DO split — the backend 400s
    // without one (boundedDbFromPageHint reads body.pageId, not patch.pageId).
    pageId: pageId ?? patch.pageId,
  });
  return result.comment;
}

export async function deleteCommentRemote(id: string, pageId: string): Promise<string> {
  const result = await getClient().functions.post<{ deletedId: string }>("comment-mutation", {
    action: "delete",
    id,
    // Routing hint + idempotent-delete access check on the backend.
    pageId,
  });
  return result.deletedId;
}

export async function deleteCommentsRemote(ids: string[], pageId: string): Promise<string[]> {
  const result = await getClient().functions.post<{ deletedIds: string[] }>("comment-mutation", {
    action: "deleteMany",
    ids,
    pageId,
  });
  return result.deletedIds;
}

export async function updateCommentsRemote(
  updates: Array<{ id: string; patch: Partial<Comment> }>,
  pageId?: string
): Promise<Comment[]> {
  // An empty updateMany cannot carry a routing pageId and the backend rejects
  // it; it is also a no-op, so don't spend a request (or an outbox replay).
  if (updates.length === 0) return [];
  const result = await getClient().functions.post<{ comments: Comment[] }>("comment-mutation", {
    action: "updateMany",
    updates,
    pageId: pageId ?? updates.find((update) => update.patch.pageId)?.patch.pageId,
  });
  return result.comments;
}

export interface CreateDatabaseRowInput {
  id?: string;
  databaseId: string;
  title?: string;
  templateId?: string;
  empty?: boolean;
  properties?: Record<string, unknown>;
  position?: number;
}

export interface CreateDatabaseInput {
  id?: string;
  /** Client-generated starter view id for local-first optimistic creation. */
  viewId?: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: PageParentType;
  title?: string;
  position?: number;
  afterPosition?: number;
  viewType?: Extract<ViewType, "table" | "board" | "list" | "gallery" | "calendar" | "timeline">;
  seedRows?: boolean;
  /** Locale for server-generated resource names. Omitted callers retain English defaults. */
  locale?: "en" | "ko";
  properties?: Array<
    Partial<DbProperty> & {
      options?: unknown[];
      numberFormat?: string;
      idPrefix?: string;
      relationDatabaseId?: string;
      formula?: string;
      rollupRelationPropertyId?: string;
      rollupTargetPropertyId?: string;
      rollupFunction?: string;
      hideWhenEmpty?: boolean;
      hideInPagePanel?: boolean;
    }
  >;
}

export interface CreateDatabaseResult {
  page: Page;
  properties: DbProperty[];
  views: DbView[];
  templates: DbTemplate[];
  rows: Page[];
}

export async function createDatabaseRemote(input: CreateDatabaseInput): Promise<CreateDatabaseResult> {
  return callInteractiveMutation<CreateDatabaseResult>("database-mutation", {
    action: "createDatabase",
    ...input,
  });
}

export async function createDatabaseRowRemote(
  input: CreateDatabaseRowInput
): Promise<{ row: Page; blocks: Block[] }> {
  return callInteractiveMutation<{ row: Page; blocks: Block[] }>("database-row-mutation", {
    action: "create",
    ...input,
  });
}

export async function updateDatabaseRowRemote(
  id: string,
  patch: Partial<Page>
): Promise<Page> {
  const result = await callInteractiveMutation<{ row: Page }>("database-row-mutation", {
    action: "update",
    id,
    patch,
  });
  return result.row;
}

export async function moveDatabaseRowRemote(
  id: string,
  targetId: string,
  side: "before" | "after"
): Promise<Page> {
  const result = await callInteractiveMutation<{ row: Page }>("database-row-mutation", {
    action: "move",
    id,
    targetId,
    side,
  });
  return result.row;
}

export async function trashDatabaseRowRemote(id: string): Promise<Page[]> {
  const result = await callInteractiveMutation<PageMutationPagesResult>("database-row-mutation", {
    action: "trash",
    id,
  });
  return result.pages;
}

export async function restoreDatabaseRowRemote(id: string): Promise<Page[]> {
  const result = await callInteractiveMutation<PageMutationPagesResult>("database-row-mutation", {
    action: "restore",
    id,
  });
  return result.pages;
}

export async function deleteDatabaseRowRemote(id: string, workspaceId?: string): Promise<string[]> {
  const result = await callInteractiveMutation<PageMutationDeleteResult>("database-row-mutation", {
    action: "delete",
    id,
    workspaceId,
  });
  return result.deletedIds;
}

type DatabaseMutationTable = "db_properties" | "db_views" | "db_templates";

async function insertDatabaseRecordRemote<T>(
  table: DatabaseMutationTable,
  record: Partial<T>
): Promise<T> {
  const result = await callInteractiveMutation<{ record: T }>("database-mutation", {
    action: "insert",
    table,
    record,
  });
  return result.record;
}

async function insertDatabaseRecordsRemote<T>(
  table: DatabaseMutationTable,
  records: Array<Partial<T>>
): Promise<T[]> {
  const result = await callInteractiveMutation<{ records: T[] }>("database-mutation", {
    action: "insertMany",
    table,
    records,
  });
  return result.records;
}

async function updateDatabaseRecordRemote<T>(
  table: DatabaseMutationTable,
  id: string,
  patch: Partial<T>,
  databaseId?: string,
  extraBody?: Record<string, unknown>
): Promise<T> {
  const result = await callInteractiveMutation<{ record: T }>("database-mutation", {
    action: "update",
    table,
    id,
    patch,
    // Routing hint for the workspace-DO split; harmless before the flip.
    databaseId,
    ...extraBody,
  });
  return result.record;
}

async function updateDatabaseRecordsRemote<T>(
  table: DatabaseMutationTable,
  updates: Array<{ id: string; patch: Partial<T> }>,
  databaseId?: string
): Promise<T[]> {
  const result = await callInteractiveMutation<{ records: T[] }>("database-mutation", {
    action: "updateMany",
    table,
    updates,
    databaseId,
  });
  return result.records;
}

async function deleteDatabaseRecordRemote(
  table: DatabaseMutationTable,
  id: string,
  databaseId?: string,
  skipReciprocal?: boolean,
  previousRelatedPropertyId?: string
) {
  await callInteractiveMutation("database-mutation", {
    action: "delete",
    table,
    id,
    databaseId,
    // Two-way relations: suppress the backend reciprocal cascade when deleting
    // only the paired property during a two-way→one-way toggle.
    ...(skipReciprocal ? { skipReciprocal: true } : {}),
    ...(previousRelatedPropertyId ? { previousRelatedPropertyId } : {}),
  });
}

export function createPropertiesRemote(records: Array<Partial<DbProperty>>) {
  return insertDatabaseRecordsRemote<DbProperty>("db_properties", records);
}

export function createPropertyRemote(record: Partial<DbProperty>) {
  return insertDatabaseRecordRemote<DbProperty>("db_properties", record);
}

export function updatePropertyRemote(
  id: string,
  patch: Partial<DbProperty>,
  databaseId?: string,
  previousRelatedPropertyId?: string
) {
  return updateDatabaseRecordRemote<DbProperty>("db_properties", id, patch, databaseId, {
    ...(previousRelatedPropertyId ? { previousRelatedPropertyId } : {}),
  });
}

export function updatePropertiesRemote(updates: Array<{ id: string; patch: Partial<DbProperty> }>, databaseId?: string) {
  return updateDatabaseRecordsRemote<DbProperty>("db_properties", updates, databaseId);
}

export function deletePropertyRemote(
  id: string,
  databaseId?: string,
  skipReciprocal?: boolean,
  previousRelatedPropertyId?: string
) {
  return deleteDatabaseRecordRemote(
    "db_properties",
    id,
    databaseId,
    skipReciprocal,
    previousRelatedPropertyId
  );
}

export function createViewRemote(record: Partial<DbView>) {
  return insertDatabaseRecordRemote<DbView>("db_views", record);
}

export function createViewsRemote(records: Array<Partial<DbView>>) {
  return insertDatabaseRecordsRemote<DbView>("db_views", records);
}

export function updateViewRemote(id: string, patch: Partial<DbView>, databaseId?: string) {
  return updateDatabaseRecordRemote<DbView>("db_views", id, patch, databaseId);
}

export function updateViewsRemote(updates: Array<{ id: string; patch: Partial<DbView> }>, databaseId?: string) {
  return updateDatabaseRecordsRemote<DbView>("db_views", updates, databaseId);
}

export function deleteViewRemote(id: string, databaseId?: string) {
  return deleteDatabaseRecordRemote("db_views", id, databaseId);
}

export function createTemplateRemote(record: Partial<DbTemplate>) {
  return insertDatabaseRecordRemote<DbTemplate>("db_templates", record);
}

export function createTemplatesRemote(records: Array<Partial<DbTemplate>>) {
  return insertDatabaseRecordsRemote<DbTemplate>("db_templates", records);
}

export function updateTemplateRemote(id: string, patch: Partial<DbTemplate>, databaseId?: string) {
  return updateDatabaseRecordRemote<DbTemplate>("db_templates", id, patch, databaseId);
}

export function updateTemplatesRemote(updates: Array<{ id: string; patch: Partial<DbTemplate> }>, databaseId?: string) {
  return updateDatabaseRecordsRemote<DbTemplate>("db_templates", updates, databaseId);
}

export function deleteTemplateRemote(id: string, databaseId?: string) {
  return deleteDatabaseRecordRemote("db_templates", id, databaseId);
}

export { EDGEBASE_URL };
