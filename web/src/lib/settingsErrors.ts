import { i18next } from "@/i18n";
import { isKoreanLocale } from "./i18n";

// Well-known backend error messages (thrown as plain Errors by
// backend/functions/workspace-mutation.ts and collaboration-mutation.ts)
// mapped to a localized-copy key. The map keys are the backend's own English
// wording and are used only for data-matching, so they stay literal.
const KNOWN_BACKEND_ERROR_KEYS: Record<string, string> = {
  "Workspace admin access required.": "workspaceAdminRequired",
  "Workspace owner access required.": "workspaceOwnerRequired",
  "Only workspace owners can assign admin.": "onlyOwnersAssignAdmin",
  "Only workspace owners can manage admins.": "onlyOwnersManageAdmins",
  "Only workspace owners can remove admins.": "onlyOwnersRemoveAdmins",
  "Workspace owners cannot be changed from member management.": "ownersCannotChangeRole",
  "Workspace owners cannot be removed.": "ownersCannotBeRemoved",
  "You cannot change your own workspace role.": "cannotChangeOwnRole",
  "You cannot remove yourself from the workspace.": "cannotRemoveSelf",
  "Only admin, member, and guest roles can be assigned.": "onlyAssignableRoles",
  "Workspace member was not found.": "memberNotFound",
  "Workspace invitation was not found.": "invitationNotFound",
  "Workspace owner transfer target must be another member.": "transferTargetMustBeMember",
  "Email is required.": "emailRequired",
  "Email is invalid.": "emailInvalid",
  "External guest invitations are disabled by organization policy.": "externalGuestDisabled",
  "Verified organization domain is required for organization members.": "verifiedDomainRequired",
  "Workspace URL is already in use.": "workspaceUrlInUse",
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
    return i18next.t("settingsErrors:rateLimited");
  }
  const message = messageText(error).trim();
  if (!message) return fallback || i18next.t("settingsErrors:requestFailed");
  const knownKey = KNOWN_BACKEND_ERROR_KEYS[message];
  if (knownKey) return i18next.t(`settingsErrors:backend.${knownKey}`);
  // Backend copy is authored in English, so it doubles as the en-locale
  // message. For ko, never surface raw English: keep it in the console for
  // debugging and show the caller's (localized) contextual fallback instead.
  if (!isKoreanLocale()) return message;
  console.warn("[settings] Unlocalized backend error message:", message);
  return fallback || i18next.t("settingsErrors:requestFailed");
}

export function shouldSuppressBackgroundSettingsError(error: unknown, hasVisibleFallback: boolean) {
  return hasVisibleFallback && isRateLimitError(error);
}
