import { isKoreanLocale, pickLabels } from "./i18n";

const SETTINGS_ERROR_LABELS = {
  en: {
    rateLimited: "Too many requests right now. Please try again in a moment.",
    requestFailed: "We couldn't complete that request. Please try again.",
  },
  ko: {
    rateLimited: "요청이 잠시 몰렸어요. 잠시 후 다시 시도해 주세요.",
    requestFailed: "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.",
  },
} as const;

// Well-known backend error messages (thrown as plain Errors by
// backend/functions/workspace-mutation.ts and collaboration-mutation.ts)
// mapped to localized copy. English is the backend's own wording, so the
// en side mostly restates it; the ko side is the real payoff.
const KNOWN_BACKEND_ERRORS: Record<string, { en: string; ko: string }> = {
  "Workspace admin access required.": {
    en: "Workspace admin access is required.",
    ko: "워크스페이스 관리자 권한이 필요해요.",
  },
  "Workspace owner access required.": {
    en: "Workspace owner access is required.",
    ko: "워크스페이스 소유자 권한이 필요해요.",
  },
  "Only workspace owners can assign admin.": {
    en: "Only workspace owners can assign the admin role.",
    ko: "관리자 역할은 워크스페이스 소유자만 부여할 수 있어요.",
  },
  "Only workspace owners can manage admins.": {
    en: "Only workspace owners can manage admins.",
    ko: "관리자는 워크스페이스 소유자만 관리할 수 있어요.",
  },
  "Only workspace owners can remove admins.": {
    en: "Only workspace owners can remove admins.",
    ko: "관리자는 워크스페이스 소유자만 제거할 수 있어요.",
  },
  "Workspace owners cannot be changed from member management.": {
    en: "The workspace owner's role can't be changed here. Transfer ownership first.",
    ko: "워크스페이스 소유자의 역할은 여기서 바꿀 수 없어요. 먼저 소유권을 이전해 주세요.",
  },
  "Workspace owners cannot be removed.": {
    en: "The workspace owner can't be removed. Transfer ownership first.",
    ko: "워크스페이스 소유자는 제거할 수 없어요. 먼저 소유권을 이전해 주세요.",
  },
  "You cannot change your own workspace role.": {
    en: "You can't change your own workspace role.",
    ko: "자신의 워크스페이스 역할은 바꿀 수 없어요.",
  },
  "You cannot remove yourself from the workspace.": {
    en: "You can't remove yourself from the workspace.",
    ko: "자기 자신은 워크스페이스에서 제거할 수 없어요.",
  },
  "Only admin, member, and guest roles can be assigned.": {
    en: "Only admin, member, and guest roles can be assigned.",
    ko: "관리자, 멤버, 게스트 역할만 부여할 수 있어요.",
  },
  "Workspace member was not found.": {
    en: "That workspace member was not found.",
    ko: "해당 워크스페이스 멤버를 찾을 수 없어요.",
  },
  "Workspace invitation was not found.": {
    en: "That invitation was not found.",
    ko: "해당 초대를 찾을 수 없어요.",
  },
  "Workspace owner transfer target must be another member.": {
    en: "Choose another member to transfer ownership to.",
    ko: "소유권은 다른 멤버에게만 이전할 수 있어요.",
  },
  "Email is required.": {
    en: "Email is required.",
    ko: "이메일을 입력해 주세요.",
  },
  "Email is invalid.": {
    en: "That email address doesn't look right.",
    ko: "이메일 주소가 올바르지 않아요.",
  },
  "External guest invitations are disabled by organization policy.": {
    en: "External guest invitations are disabled by organization policy.",
    ko: "조직 정책상 외부 게스트 초대가 비활성화되어 있어요.",
  },
  "Verified organization domain is required for organization members.": {
    en: "Organization members must use a verified organization domain.",
    ko: "조직 멤버는 인증된 조직 도메인 이메일을 사용해야 해요.",
  },
  "Workspace URL is already in use.": {
    en: "That workspace URL is already in use.",
    ko: "이미 사용 중인 워크스페이스 URL이에요.",
  },
};

function statusCode(error: unknown) {
  const record = error as { status?: unknown; code?: unknown } | null;
  const status = record?.status ?? record?.code;
  return typeof status === "number" ? status : undefined;
}

function messageText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const record = error as { message?: unknown } | null;
  return typeof record?.message === "string" ? record.message : "";
}

export function isRateLimitError(error: unknown) {
  if (statusCode(error) === 429) return true;
  return /\b429\b|too many requests|rate limit/i.test(messageText(error));
}

export function settingsErrorMessage(error: unknown, fallback: string) {
  if (isRateLimitError(error)) {
    return pickLabels(SETTINGS_ERROR_LABELS).rateLimited;
  }
  const message = messageText(error).trim();
  if (!message) return fallback || pickLabels(SETTINGS_ERROR_LABELS).requestFailed;
  const known = KNOWN_BACKEND_ERRORS[message];
  if (known) return pickLabels(known);
  // Backend copy is authored in English, so it doubles as the en-locale
  // message. For ko, never surface raw English: keep it in the console for
  // debugging and show the caller's (localized) contextual fallback instead.
  if (!isKoreanLocale()) return message;
  console.warn("[settings] Unlocalized backend error message:", message);
  return fallback || pickLabels(SETTINGS_ERROR_LABELS).requestFailed;
}

export function shouldSuppressBackgroundSettingsError(error: unknown, hasVisibleFallback: boolean) {
  return hasVisibleFallback && isRateLimitError(error);
}
