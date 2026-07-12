"use client";

import {
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import * as QRCode from "qrcode";
import { activeDateLocale } from "@/lib/i18n";
import {
  addOrganizationGroupMemberRemote,
  addOrganizationDomainRemote,
  changePasswordRemote,
  cleanupExpiredFileUploadsRemote,
  createInstanceBackupSnapshotRemote,
  createInstanceUserRemote,
  createManualMcpTokenRemote,
  createOrganizationGroupRemote,
  deactivateOrganizationMemberRemote,
  deleteInstanceUserRemote,
  deleteOrganizationGroupRemote,
  disableTotpRemote,
  enrollTotpRemote,
  getInstanceAdminRemote,
  getFileUsageReportRemote,
  getOrganizationDirectoryRemote,
  getWorkspaceMembersRemote,
  addWorkspaceMemberRemote,
  searchServerUsersRemote,
  listMcpConnectionsRemote,
  listAuthSessionsRemote,
  listMfaFactorsRemote,
  reactivateOrganizationMemberRemote,
  regenerateRecoveryCodesRemote,
  removeOrganizationGroupMemberRemote,
  removeWorkspaceMemberRemote,
  removeOrganizationMemberRemote,
  removeOrganizationDomainRemote,
  revokeMcpConnectionRemote,
  revokeAuthSessionRemote,
  revokeInstanceUserSessionsRemote,
  setInstanceAdminRemote,
  setInstanceUserDisabledRemote,
  resetInstanceUserPasswordRemote,
  transferOrganizationOwnerRemote,
  transferWorkspaceOwnerRemote,
  currentUserEmail,
  currentUserId,
  updateInstanceSignupPolicyRemote,
  updateMyWorkspaceProfileRemote,
  updateOrganizationGroupRemote,
  updateOrganizationMemberRoleRemote,
  updateOrganizationSettingsRemote,
  updateWorkspaceMemberRoleRemote,
  verifyTotpEnrollmentRemote,
  verifyOrganizationDomainRemote,
  type AuthSession,
  type McpConnectionsResult,
  type McpCreatedToken,
  type MfaFactor,
  type ServerUserSummary,
  type TotpEnrollment,
} from "@/lib/edgebase";
import { currentLanguagePreference, i18next, setLanguagePreference } from "@/i18n";
import { LANGUAGE_OPTIONS } from "@/i18n/languages";
import { useTranslation } from "react-i18next";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { localEncryptionMode, type LocalEncryptionMode } from "@/lib/localLock";
import { useRouter } from "@/lib/router";
import { settingsErrorMessage, shouldSuppressBackgroundSettingsError } from "@/lib/settingsErrors";
import {
  changeLocalPassphrase,
  disableLocalPassphraseLock,
  enableLocalPassphraseLock,
  useStore,
  type LocalLockChangeResult,
} from "@/lib/store";
import { useTheme, type ThemePref } from "@/lib/theme";
import type {
  FileMaintenanceRun,
  FileUsageReport,
  DomainSignupPolicy,
  InstanceAdminUser,
  ServerAuditSummaryEvent,
  ServerBackupSummary,
  ServerImportJobSummary,
  ServerOverviewSummary,
  ServerSecuritySummary,
  ServerSystemSummary,
  ServerUsageSummary,
  ServerWorkspaceSummary,
  OrganizationAuditEvent,
  OrganizationDomain,
  OrganizationGroup,
  OrganizationGroupMember,
  OrganizationMember,
  OrganizationMemberRole,
  OrganizationProfile,
  OrganizationSharingPolicyKey,
  SignupPolicy,
  WorkspaceCreationPolicy,
  WorkspaceMember,
} from "@/lib/types";
import { EmojiPicker } from "./EmojiPicker";
import { ImportedPeopleMapping } from "./ImportedPeopleMapping";
import { GlobeIcon, LockIcon, PaletteIcon, Search, SharePeopleIcon, Upload, UserIcon } from "./icons";
import { WorkspaceIconGlyph } from "./PageIcon";
import { SupportSection } from "./SupportSection";
import styles from "./WorkspaceSettingsDialog.module.css";

// User-facing copy for this surface lives in the i18next catalogs at
// src/locales/<lang>/workspaceSettingsDialog.json (English is the source of
// truth). LABELS is an i18next-backed facade so module-scope helpers and
// options arrays keep the same call sites; components additionally call the
// useTranslation hook so they re-render on language change.
const WS_NS = "workspaceSettingsDialog";

function wt(key: string, options?: Record<string, unknown>): string {
  return i18next.t(`${WS_NS}:${key}`, options) as string;
}

const LABELS = {
  get add() { return i18next.t("common:actions.add") as string; },
  get save() { return i18next.t("common:actions.save") as string; },
  get delete() { return i18next.t("common:actions.delete") as string; },
  get boolYes() { return wt("boolYes"); },
  get boolNo() { return wt("boolNo"); },
  get auditDetailLimitNone() { return wt("auditDetailLimitNone"); },
  get auditDetailFallback() { return wt("auditDetailFallback"); },
  get cleanUp() { return wt("cleanUp"); },
  get copy() { return wt("copy"); },
  get invite() { return wt("invite"); },
  get refresh() { return wt("refresh"); },
  get remove() { return wt("remove"); },
  get revoke() { return wt("revoke"); },
  get verify() { return wt("verify"); },
  get adminOnlyNotice() { return wt("adminOnlyNotice"); },
  get adminRequired() { return wt("adminRequired"); },
  get clipboardCopyFailed() { return wt("clipboardCopyFailed"); },
  get me() { return wt("me"); },
  get member() { return wt("member"); },
  get myAccount() { return wt("myAccount"); },
  get none() { return wt("none"); },
  get noSearchResults() { return wt("noSearchResults"); },
  get untitledWorkspace() { return wt("untitledWorkspace"); },
  get roleAdmin() { return wt("roleAdmin"); },
  get roleBillingAdmin() { return wt("roleBillingAdmin"); },
  get roleGuest() { return wt("roleGuest"); },
  get roleMember() { return wt("roleMember"); },
  get roleOwner() { return wt("roleOwner"); },
  get roleSecurityAdmin() { return wt("roleSecurityAdmin"); },
  get themeDark() { return wt("themeDark"); },
  get themeLight() { return wt("themeLight"); },
  get themeSystem() { return wt("themeSystem"); },
  get languageField() { return wt("languageField"); },
  get languageSystem() { return wt("languageSystem"); },
  get policyMembers() { return wt("policyMembers"); },
  get policyOwnersAdmins() { return wt("policyOwnersAdmins"); },
  get signupInviteOnly() { return wt("signupInviteOnly"); },
  get signupPublic() { return wt("signupPublic"); },
  get signupClosed() { return wt("signupClosed"); },
  get signupVerifiedDomains() { return wt("signupVerifiedDomains"); },
  get domainSignupVerified() { return wt("domainSignupVerified"); },
  get sharingExternalEmail() { return wt("sharingExternalEmail"); },
  get sharingFileDownloads() { return wt("sharingFileDownloads"); },
  get sharingFullAccess() { return wt("sharingFullAccess"); },
  get sharingGuests() { return wt("sharingGuests"); },
  get sharingPublicWeb() { return wt("sharingPublicWeb"); },
  get auditAllEvents() { return wt("auditAllEvents"); },
  get auditLoginAttempt() { return wt("auditLoginAttempt"); },
  get auditSettingsUpdate() { return wt("auditSettingsUpdate"); },
  get auditMemberDeactivate() { return wt("auditMemberDeactivate"); },
  get auditMemberReactivate() { return wt("auditMemberReactivate"); },
  get auditMemberRoleUpdate() { return wt("auditMemberRoleUpdate"); },
  get auditMemberRemove() { return wt("auditMemberRemove"); },
  get auditOwnerTransfer() { return wt("auditOwnerTransfer"); },
  get auditDomainCreate() { return wt("auditDomainCreate"); },
  get auditDomainVerify() { return wt("auditDomainVerify"); },
  get auditDomainRemove() { return wt("auditDomainRemove"); },
  get auditWorkspaceCreate() { return wt("auditWorkspaceCreate"); },
  get auditWorkspaceDelete() { return wt("auditWorkspaceDelete"); },
  get auditWorkspaceOwnerTransfer() { return wt("auditWorkspaceOwnerTransfer"); },
  get auditInviteEmailSent() { return wt("auditInviteEmailSent"); },
  get auditInviteEmailFailed() { return wt("auditInviteEmailFailed"); },
  get auditInviteEmailNotConfigured() { return wt("auditInviteEmailNotConfigured"); },
  get auditWebShare() { return wt("auditWebShare"); },
  get auditPagePermissionGrant() { return wt("auditPagePermissionGrant"); },
  get auditPagePermissionUpdate() { return wt("auditPagePermissionUpdate"); },
  get auditPagePermissionRevoke() { return wt("auditPagePermissionRevoke"); },
  get auditExportPage() { return wt("auditExportPage"); },
  get auditExportDatabase() { return wt("auditExportDatabase"); },
  get auditExportWorkspace() { return wt("auditExportWorkspace"); },
  get auditPageDelete() { return wt("auditPageDelete"); },
  get auditDatabaseRowDelete() { return wt("auditDatabaseRowDelete"); },
  get statusActive() { return wt("statusActive"); },
  get statusDeactivated() { return wt("statusDeactivated"); },
  get statusPending() { return wt("statusPending"); },
  get statusRejected() { return wt("statusRejected"); },
  get statusVerified() { return wt("statusVerified"); },
  get instanceAdminBadge() { return wt("instanceAdminBadge"); },
  get scopeOrganization() { return wt("scopeOrganization"); },
  get scopeServer() { return wt("scopeServer"); },
  get auditSessionsRevoked() { return wt("auditSessionsRevoked"); },
  get jobCancelled() { return wt("jobCancelled"); },
  get jobCompleted() { return wt("jobCompleted"); },
  get jobDiscovering() { return wt("jobDiscovering"); },
  get jobFailed() { return wt("jobFailed"); },
  get jobQueued() { return wt("jobQueued"); },
  get jobReady() { return wt("jobReady"); },
  get jobUnknown() { return wt("jobUnknown"); },
  get healthAttention() { return wt("healthAttention"); },
  get healthMissing() { return wt("healthMissing"); },
  get healthOk() { return wt("healthOk"); },
  get codeOrPasswordMismatch() { return wt("codeOrPasswordMismatch"); },
  get recoveryCodeMismatch() { return wt("recoveryCodeMismatch"); },
  get storageLimitInvalid() { return wt("storageLimitInvalid"); },
  get totpCodeMismatch() { return wt("totpCodeMismatch"); },
  get memberAddFailed() { return wt("memberAddFailed"); },
  get memberEmailInvalid() { return wt("memberEmailInvalid"); },
  get memberEmailRequired() { return wt("memberEmailRequired"); },
  get memberInvitationRemoveFailed() { return wt("memberInvitationRemoveFailed"); },
  get memberRemoveFailed() { return wt("memberRemoveFailed"); },
  get memberRoleUpdateFailed() { return wt("memberRoleUpdateFailed"); },
  get ownerTransferFailed() { return wt("ownerTransferFailed"); },
  get searchActiveUser() { return wt("searchActiveUser"); },
  get searchDisabledUser() { return wt("searchDisabledUser"); },
  get searchInstanceAdmin() { return wt("searchInstanceAdmin"); },
  get deliveryEmailFailed() { return wt("deliveryEmailFailed"); },
  get deliveryEmailNotConfigured() { return wt("deliveryEmailNotConfigured"); },
  get deliveryEmailPending() { return wt("deliveryEmailPending"); },
  get deliveryEmailSent() { return wt("deliveryEmailSent"); },
  get invitePending() { return wt("invitePending"); },
  get navAccountGroup() { return wt("navAccountGroup"); },
  get navAccountSecurity() { return wt("navAccountSecurity"); },
  get navAccountsSignup() { return wt("navAccountsSignup"); },
  get navAiConnections() { return wt("navAiConnections"); },
  get navAuditLog() { return wt("navAuditLog"); },
  get navBackup() { return wt("navBackup"); },
  get navImports() { return wt("navImports"); },
  get navOverview() { return wt("navOverview"); },
  get navPoliciesDomains() { return wt("navPoliciesDomains"); },
  get navProfile() { return wt("navProfile"); },
  get navSecurityGroup() { return wt("navSecurityGroup"); },
  get navServerGroup() { return wt("navServerGroup"); },
  get navServerSecurity() { return wt("navServerSecurity"); },
  get navServerWorkspaces() { return wt("navServerWorkspaces"); },
  get navSharingSecurity() { return wt("navSharingSecurity"); },
  get navSystem() { return wt("navSystem"); },
  get navUsage() { return wt("navUsage"); },
  get navUsageFiles() { return wt("navUsageFiles"); },
  get navWorkspaceGroup() { return wt("navWorkspaceGroup"); },
  get navWorkspaceMembers() { return wt("navWorkspaceMembers"); },
  get accountConsole() { return wt("accountConsole"); },
  get accountConsoleSubtitle() { return wt("accountConsoleSubtitle"); },
  get hanjiServer() { return wt("hanjiServer"); },
  get instanceLabel() { return wt("instanceLabel"); },
  get serverConsole() { return wt("serverConsole"); },
  get serverConsoleSubtitle() { return wt("serverConsoleSubtitle"); },
  get workspaceConsole() { return wt("workspaceConsole"); },
  get workspaceConsoleSubtitle() { return wt("workspaceConsoleSubtitle"); },
  get accountsTile() { return wt("accountsTile"); },
  get activeStorageTile() { return wt("activeStorageTile"); },
  get activeUsers() { return wt("activeUsers"); },
  get failedImportsTile() { return wt("failedImportsTile"); },
  get instanceAdminsTile() { return wt("instanceAdminsTile"); },
  get lastUpdated() { return wt("lastUpdated"); },
  get loadingServerStatus() { return wt("loadingServerStatus"); },
  get noServerStatus() { return wt("noServerStatus"); },
  get operationalStatus() { return wt("operationalStatus"); },
  get pagesDbsTile() { return wt("pagesDbsTile"); },
  get serverOverviewMeta() { return wt("serverOverviewMeta"); },
  get serverOverviewTitle() { return wt("serverOverviewTitle"); },
  get workspacesTile() { return wt("workspacesTile"); },
  get allAccountsTile() { return wt("allAccountsTile"); },
  get createAccount() { return wt("createAccount"); },
  get createAccountFailed() { return wt("createAccountFailed"); },
  get disabledAccountsTile() { return wt("disabledAccountsTile"); },
  get enterEmail() { return wt("enterEmail"); },
  get instanceMeta() { return wt("instanceMeta"); },
  get instanceTitle() { return wt("instanceTitle"); },
  get loadingAccounts() { return wt("loadingAccounts"); },
  get makeAdmin() { return wt("makeAdmin"); },
  get namePlaceholder() { return wt("namePlaceholder"); },
  get newAccountEmailPlaceholder() { return wt("newAccountEmailPlaceholder"); },
  get newAccountPasswordPlaceholder() { return wt("newAccountPasswordPlaceholder"); },
  get noInstanceAccounts() { return wt("noInstanceAccounts"); },
  get removeAdmin() { return wt("removeAdmin"); },
  get restore() { return wt("restore"); },
  get deactivate() { return wt("deactivate"); },
  get reactivate() { return wt("reactivate"); },
  get searchAccountsPlaceholder() { return wt("searchAccountsPlaceholder"); },
  get signupTitle() { return wt("signupTitle"); },
  get signupHelpInviteOnly() { return wt("signupHelpInviteOnly"); },
  get signupHelpClosed() { return wt("signupHelpClosed"); },
  get signupHelpPublic() { return wt("signupHelpPublic"); },
  get signupHelpVerified() { return wt("signupHelpVerified"); },
  get temporaryPasswordCopied() { return wt("temporaryPasswordCopied"); },
  get temporaryPasswordPrefix() { return wt("temporaryPasswordPrefix"); },
  get verifiedAccountsTile() { return wt("verifiedAccountsTile"); },
  get searchWorkspacesPlaceholder() { return wt("searchWorkspacesPlaceholder"); },
  get serverWorkspacesMeta() { return wt("serverWorkspacesMeta"); },
  get serverWorkspacesTitle() { return wt("serverWorkspacesTitle"); },
  get noWorkspaces() { return wt("noWorkspaces"); },
  get available() { return wt("available"); },
  get awaiting() { return wt("awaiting"); },
  get mfaResetTile() { return wt("mfaResetTile"); },
  get revokeSessionsButton() { return wt("revokeSessionsButton"); },
  get revokeSessionsFailed() { return wt("revokeSessionsFailed"); },
  get serverSecurityMeta() { return wt("serverSecurityMeta"); },
  get serverSecurityTitle() { return wt("serverSecurityTitle"); },
  get sessionRevocationTile() { return wt("sessionRevocationTile"); },
  get temporaryPasswordButton() { return wt("temporaryPasswordButton"); },
  get resetPasswordFailed() { return wt("resetPasswordFailed"); },
  get unavailable() { return wt("unavailable"); },
  get allActions() { return wt("allActions"); },
  get loadingAuditLog() { return wt("loadingAuditLog"); },
  get noAuditLog() { return wt("noAuditLog"); },
  get serverAuditMeta() { return wt("serverAuditMeta"); },
  get serverAuditTitle() { return wt("serverAuditTitle"); },
  get allStatuses() { return wt("allStatuses"); },
  get loadingImportJobs() { return wt("loadingImportJobs"); },
  get noImportJobs() { return wt("noImportJobs"); },
  get serverJobsMeta() { return wt("serverJobsMeta"); },
  get serverJobsTitle() { return wt("serverJobsTitle"); },
  get expiredTile() { return wt("expiredTile"); },
  get filesTile() { return wt("filesTile"); },
  get pendingTile() { return wt("pendingTile"); },
  get recentCleanup() { return wt("recentCleanup"); },
  get serverUsageMeta() { return wt("serverUsageMeta"); },
  get serverUsageTitle() { return wt("serverUsageTitle"); },
  get backupTitle() { return wt("backupTitle"); },
  get downloadableTables() { return wt("downloadableTables"); },
  get downloadSnapshot() { return wt("downloadSnapshot"); },
  get lastGenerated() { return wt("lastGenerated"); },
  get onHold() { return wt("onHold"); },
  get productData() { return wt("productData"); },
  get restoreUiTile() { return wt("restoreUiTile"); },
  get serverBackupMeta() { return wt("serverBackupMeta"); },
  get snapshotDownloaded() { return wt("snapshotDownloaded"); },
  get snapshotFailed() { return wt("snapshotFailed"); },
  get snapshotScope() { return wt("snapshotScope"); },
  get configured() { return wt("configured"); },
  get loadingSystem() { return wt("loadingSystem"); },
  get noSystemSummary() { return wt("noSystemSummary"); },
  get notConfigured() { return wt("notConfigured"); },
  get serverSystemMeta() { return wt("serverSystemMeta"); },
  get serverSystemTitle() { return wt("serverSystemTitle"); },
  get changeIcon() { return wt("changeIcon"); },
  get deleteAdminRequired() { return wt("deleteAdminRequired"); },
  get deleteConfirmAriaLabel() { return wt("deleteConfirmAriaLabel"); },
  get deleteNameMismatch() { return wt("deleteNameMismatch"); },
  get deleteWorkspace() { return wt("deleteWorkspace"); },
  get deleteWorkspaceConfirmLabel() { return wt("deleteWorkspaceConfirmLabel"); },
  get deleteWorkspaceDesc() { return wt("deleteWorkspaceDesc"); },
  get deleteWorkspaceFailed() { return wt("deleteWorkspaceFailed"); },
  get deleting() { return wt("deleting"); },
  get iconField() { return wt("iconField"); },
  get lastWorkspaceError() { return wt("lastWorkspaceError"); },
  get nameField() { return wt("nameField"); },
  get needAnotherWorkspace() { return wt("needAnotherWorkspace"); },
  get onlyAdminsDelete() { return wt("onlyAdminsDelete"); },
  get workspaceDeleted() { return wt("workspaceDeleted"); },
  get workspaceSectionTitle() { return wt("workspaceSectionTitle"); },
  get workspaceUrlField() { return wt("workspaceUrlField"); },
  get workspaceUrlSaving() { return wt("workspaceUrlSaving"); },
  get accountEmail() { return wt("accountEmail"); },
  get accountId() { return wt("accountId"); },
  get displayNamePlaceholder() { return wt("displayNamePlaceholder"); },
  get emailPlaceholder() { return wt("emailPlaceholder"); },
  get preferencesTitle() { return wt("preferencesTitle"); },
  get profileIconField() { return wt("profileIconField"); },
  get saveProfileButton() { return wt("saveProfileButton"); },
  get themeField() { return wt("themeField"); },
  get activeSessionsDesc() { return wt("activeSessionsDesc"); },
  get activeSessionsTitle() { return wt("activeSessionsTitle"); },
  get advancedUriSummary() { return wt("advancedUriSummary"); },
  get applyVerification() { return wt("applyVerification"); },
  get authKeyCopied() { return wt("authKeyCopied"); },
  get changePasswordButton() { return wt("changePasswordButton"); },
  get codeOrPasswordPlaceholder() { return wt("codeOrPasswordPlaceholder"); },
  get confirmNewPassword() { return wt("confirmNewPassword"); },
  get copyCodes() { return wt("copyCodes"); },
  get copyKey() { return wt("copyKey"); },
  get copyUri() { return wt("copyUri"); },
  get current() { return wt("current"); },
  get currentPassword() { return wt("currentPassword"); },
  get currentSession() { return wt("currentSession"); },
  get enterCodeDesc() { return wt("enterCodeDesc"); },
  get enterCodeOrPassword() { return wt("enterCodeOrPassword"); },
  get enterCodeTitle() { return wt("enterCodeTitle"); },
  get enterCurrentAndNewPassword() { return wt("enterCurrentAndNewPassword"); },
  get enterSixDigitCode() { return wt("enterSixDigitCode"); },
  get loadAccountSecurityFailed() { return wt("loadAccountSecurityFailed"); },
  get loadingSessions() { return wt("loadingSessions"); },
  get manageRecoveryDesc() { return wt("manageRecoveryDesc"); },
  get manageRecoveryTitle() { return wt("manageRecoveryTitle"); },
  get manualKeyLabel() { return wt("manualKeyLabel"); },
  get mfaDisabledDesc() { return wt("mfaDisabledDesc"); },
  get mfaDisabledNotice() { return wt("mfaDisabledNotice"); },
  get mfaDisableFailed() { return wt("mfaDisableFailed"); },
  get mfaEnabledDesc() { return wt("mfaEnabledDesc"); },
  get mfaEnabledNotice() { return wt("mfaEnabledNotice"); },
  get mfaEnrollFailed() { return wt("mfaEnrollFailed"); },
  get mfaOff() { return wt("mfaOff"); },
  get mfaOn() { return wt("mfaOn"); },
  get mfaSetupAriaLabel() { return wt("mfaSetupAriaLabel"); },
  get mfaSetupIntro() { return wt("mfaSetupIntro"); },
  get mfaTitle() { return wt("mfaTitle"); },
  get mfaTurnOff() { return wt("mfaTurnOff"); },
  get mfaTurnOn() { return wt("mfaTurnOn"); },
  get mfaVerifyFailed() { return wt("mfaVerifyFailed"); },
  get newPassword() { return wt("newPassword"); },
  get newPasswordMismatch() { return wt("newPasswordMismatch"); },
  get newPasswordTooShort() { return wt("newPasswordTooShort"); },
  get noActiveSessions() { return wt("noActiveSessions"); },
  get passwordChangedNotice() { return wt("passwordChangedNotice"); },
  get passwordChangeFailed() { return wt("passwordChangeFailed"); },
  get passwordDesc() { return wt("passwordDesc"); },
  get passwordTitle() { return wt("passwordTitle"); },
  get qrAlt() { return wt("qrAlt"); },
  get qrCodeFailed() { return wt("qrCodeFailed"); },
  get qrCreating() { return wt("qrCreating"); },
  get qrFallbackSummary() { return wt("qrFallbackSummary"); },
  get recoveryCodesCopied() { return wt("recoveryCodesCopied"); },
  get recoveryCodesDesc() { return wt("recoveryCodesDesc"); },
  get recoveryCodesKeepSafe() { return wt("recoveryCodesKeepSafe"); },
  get recoveryCodesTitle() { return wt("recoveryCodesTitle"); },
  get recoveryFileCreated() { return wt("recoveryFileCreated"); },
  get recoveryRegeneratedNotice() { return wt("recoveryRegeneratedNotice"); },
  get recoveryRegenerateFailed() { return wt("recoveryRegenerateFailed"); },
  get regenerateCodes() { return wt("regenerateCodes"); },
  get revokeOtherSessions() { return wt("revokeOtherSessions"); },
  get saveAsText() { return wt("saveAsText"); },
  get scanQrDesc() { return wt("scanQrDesc"); },
  get scanQrTitle() { return wt("scanQrTitle"); },
  get setupInProgress() { return wt("setupInProgress"); },
  get setupUriCopied() { return wt("setupUriCopied"); },
  get setupUriLabel() { return wt("setupUriLabel"); },
  get unknownDevice() { return wt("unknownDevice"); },
  get accessTokenCopied() { return wt("accessTokenCopied"); },
  get aiConnectionRevoked() { return wt("aiConnectionRevoked"); },
  get allAccessible() { return wt("allAccessible"); },
  get connectedAiTitle() { return wt("connectedAiTitle"); },
  get copyAccess() { return wt("copyAccess"); },
  get copyRefresh() { return wt("copyRefresh"); },
  get copyUrl() { return wt("copyUrl"); },
  get createToken() { return wt("createToken"); },
  get disconnect() { return wt("disconnect"); },
  get loadingConnectionList() { return wt("loadingConnectionList"); },
  get loadingConnections() { return wt("loadingConnections"); },
  get loadingEllipsis() { return wt("loadingEllipsis"); },
  get manualTokenCreated() { return wt("manualTokenCreated"); },
  get manualTokensDesc() { return wt("manualTokensDesc"); },
  get manualTokensTitle() { return wt("manualTokensTitle"); },
  get mcpEmptyHint() { return wt("mcpEmptyHint"); },
  get mcpMeta() { return wt("mcpMeta"); },
  get mcpScopeNote() { return wt("mcpScopeNote"); },
  get mcpServerUrlDesc() { return wt("mcpServerUrlDesc"); },
  get mcpServerUrlTitle() { return wt("mcpServerUrlTitle"); },
  get mcpSnippetsTitle() { return wt("mcpSnippetsTitle"); },
  get mcpSnippetsDesc() { return wt("mcpSnippetsDesc"); },
  get mcpSnippetClaudeCode() { return wt("mcpSnippetClaudeCode"); },
  get mcpSnippetCursor() { return wt("mcpSnippetCursor"); },
  get mcpSnippetGeneric() { return wt("mcpSnippetGeneric"); },
  get mcpSnippetCopied() { return wt("mcpSnippetCopied"); },
  get copySnippet() { return wt("copySnippet"); },
  get mcpUrlCopied() { return wt("mcpUrlCopied"); },
  get mcpUrlUnavailable() { return wt("mcpUrlUnavailable"); },
  get newManualTokenDesc() { return wt("newManualTokenDesc"); },
  get newManualTokenTitle() { return wt("newManualTokenTitle"); },
  get noAiApps() { return wt("noAiApps"); },
  get readOnly() { return wt("readOnly"); },
  get readWrite() { return wt("readWrite"); },
  get refreshTokenCopied() { return wt("refreshTokenCopied"); },
  get revokedBadge() { return wt("revokedBadge"); },
  get selectedScope() { return wt("selectedScope"); },
  get addMembers() { return wt("addMembers"); },
  get cancelInvite() { return wt("cancelInvite"); },
  get loadingMembers() { return wt("loadingMembers"); },
  get makeOwner() { return wt("makeOwner"); },
  get noMembers() { return wt("noMembers"); },
  get searchPeoplePlaceholder() { return wt("searchPeoplePlaceholder"); },
  get noOrganizationYet() { return wt("noOrganizationYet"); },
  get orgSecurityAdminRequired() { return wt("orgSecurityAdminRequired"); },
  get sharingPoliciesTitle() { return wt("sharingPoliciesTitle"); },
  get workspaceSecurityMeta() { return wt("workspaceSecurityMeta"); },
  get workspaceSecurityTitle() { return wt("workspaceSecurityTitle"); },
  get addDomain() { return wt("addDomain"); },
  get addGroup() { return wt("addGroup"); },
  get addPerson() { return wt("addPerson"); },
  get domainPolicyAddHint() { return wt("domainPolicyAddHint"); },
  get domainPolicyInviteVerified() { return wt("domainPolicyInviteVerified"); },
  get domainPolicyVerifiedRequired() { return wt("domainPolicyVerifiedRequired"); },
  get domainSignupTitle() { return wt("domainSignupTitle"); },
  get domainsTitle() { return wt("domainsTitle"); },
  get groupsTitle() { return wt("groupsTitle"); },
  get loadingOrganization() { return wt("loadingOrganization"); },
  get noContentToTransfer() { return wt("noContentToTransfer"); },
  get noDomains() { return wt("noDomains"); },
  get noGroups() { return wt("noGroups"); },
  get noMatchingAudit() { return wt("noMatchingAudit"); },
  get noOrgMembers() { return wt("noOrgMembers"); },
  get orgAdminRequired() { return wt("orgAdminRequired"); },
  get organizationAdminTitle() { return wt("organizationAdminTitle"); },
  get organizationFallback() { return wt("organizationFallback"); },
  get workspaceCreationTitle() { return wt("workspaceCreationTitle"); },
  get deletedBytes() { return wt("deletedBytes"); },
  get lastCleanup() { return wt("lastCleanup"); },
  get cleanupResult() { return wt("cleanupResult"); },
  get limitTile() { return wt("limitTile"); },
  get loadingUsage() { return wt("loadingUsage"); },
  get noFilesYet() { return wt("noFilesYet"); },
  get noLimit() { return wt("noLimit"); },
  get orgUsageTitle() { return wt("orgUsageTitle"); },
  get storageLimitField() { return wt("storageLimitField"); },
  get uploadedBytes() { return wt("uploadedBytes"); },
  get workspaceUsageTitle() { return wt("workspaceUsageTitle"); },
  get changePassphrase() { return wt("changePassphrase"); },
  get confirmNewPassphrase() { return wt("confirmNewPassphrase"); },
  get confirmPassphrase() { return wt("confirmPassphrase"); },
  get currentPassphrase() { return wt("currentPassphrase"); },
  get enterCurrentPassphrase() { return wt("enterCurrentPassphrase"); },
  get localLockForgetWarning() { return wt("localLockForgetWarning"); },
  get localLockOffDesc() { return wt("localLockOffDesc"); },
  get localLockOnDesc() { return wt("localLockOnDesc"); },
  get localLockTitle() { return wt("localLockTitle"); },
  get lockDisabledNotice() { return wt("lockDisabledNotice"); },
  get lockEnabledNotice() { return wt("lockEnabledNotice"); },
  get lockOffWithPass() { return wt("lockOffWithPass"); },
  get lockOn() { return wt("lockOn"); },
  get lockPassphrase() { return wt("lockPassphrase"); },
  get lockPendingChanges() { return wt("lockPendingChanges"); },
  get lockUnavailable() { return wt("lockUnavailable"); },
  get lockWrongPassphrase() { return wt("lockWrongPassphrase"); },
  get newPassphrase() { return wt("newPassphrase"); },
  get newPassphraseMismatch() { return wt("newPassphraseMismatch"); },
  get newPassphraseTooShort() { return wt("newPassphraseTooShort"); },
  get passphraseChangedNotice() { return wt("passphraseChangedNotice"); },
  get passphraseMismatch() { return wt("passphraseMismatch"); },
  get passphraseTooShort() { return wt("passphraseTooShort"); },
  cleanupResultSummary: (expired: string | number, failed: string | number) => wt("cleanupResultSummary", { expired, failed }),
  fileCount: (count: string | number) => wt("fileCount", { count }),
  importFailures: (count: string | number) => wt("importFailures", { count }),
  instanceUserTotals: (users: string | number, admins: string | number) => wt("instanceUserTotals", { users, admins }),
  itemsOfTotal: (total: string | number, shown: string | number) => wt("itemsOfTotal", { total, shown }),
  jobFailedItems: (count: string | number) => wt("jobFailedItems", { count }),
  jobItemCounts: (items: string | number, mapped: string | number) => wt("jobItemCounts", { items, mapped }),
  lastUsedAt: (date: string | number) => wt("lastUsedAt", { date }),
  maintenanceRunSummary: (scanned: string | number, expired: string | number, failed: string | number) => wt("maintenanceRunSummary", { scanned, expired, failed }),
  peopleOfTotal: (total: string | number, shown: string | number) => wt("peopleOfTotal", { total, shown }),
  removeNamed: (name: string | number) => wt("removeNamed", { name }),
  transferContentTo: (name: string | number) => wt("transferContentTo", { name }),
  userScopeCounts: (workspaces: string | number, organizations: string | number) => wt("userScopeCounts", { workspaces, organizations }),
  verifiedAt: (date: string | number) => wt("verifiedAt", { date }),
  workspaceMemberCounts: (members: string | number, pages: string | number, databases: string | number) => wt("workspaceMemberCounts", { members, pages, databases }),
  confirmDeleteUser: (label: string | number) => wt("confirmDeleteUser", { label }),
  confirmResetPassword: (label: string | number) => wt("confirmResetPassword", { label }),
  confirmRevokeSessions: (label: string | number) => wt("confirmRevokeSessions", { label }),
  auditTarget: (target: string | number) => wt("auditTarget", { target }),
  auditWorkspaceRef: (id: string | number) => wt("auditWorkspaceRef", { id }),
  auditActorRef: (id: string | number) => wt("auditActorRef", { id }),
  auditSignupPolicyRef: (policy: string | number) => wt("auditSignupPolicyRef", { policy }),
  auditDetailTarget: (value: string | number) => wt("auditDetailTarget", { value }),
  auditDetailMethod: (value: string | number) => wt("auditDetailMethod", { value }),
  auditDetailPhase: (value: string | number) => wt("auditDetailPhase", { value }),
  auditDetailOutcome: (value: string | number) => wt("auditDetailOutcome", { value }),
  auditDetailRole: (value: string | number) => wt("auditDetailRole", { value }),
  auditDetailPrincipal: (value: string | number) => wt("auditDetailPrincipal", { value }),
  auditDetailEnabled: (value: string | number) => wt("auditDetailEnabled", { value }),
  auditDetailPages: (value: string | number) => wt("auditDetailPages", { value }),
  auditDetailRows: (value: string | number) => wt("auditDetailRows", { value }),
  auditDetailDeletedPages: (value: string | number) => wt("auditDetailDeletedPages", { value }),
  auditDetailLimit: (value: string | number) => wt("auditDetailLimit", { value }),
  auditDetailActor: (value: string | number) => wt("auditDetailActor", { value }),
  activeSessionsCount: (count: number) => wt("activeSessionsCount", { count }),
  grantsCount: (count: number) => wt("grantsCount", { count }),
  orgMembersCount: (count: number) => wt("orgMembersCount", { count }),
  pendingInvitesCount: (count: number) => wt("pendingInvitesCount", { count }),
  peopleCount: (count: number) => wt("peopleCount", { count }),
  workspacesCount: (count: number) => wt("workspacesCount", { count }),
  auditDisabledRef: (disabled: boolean) => wt("auditDisabledRef", { value: disabled ? wt("boolYes") : wt("boolNo") }),
};

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "light", label: LABELS.themeLight },
  { value: "dark", label: LABELS.themeDark },
  { value: "system", label: LABELS.themeSystem },
];

const MEMBER_ROLE_OPTIONS: Array<{ value: WorkspaceMember["role"]; label: string }> = [
  { value: "admin", label: LABELS.roleAdmin },
  { value: "member", label: LABELS.roleMember },
  { value: "guest", label: LABELS.roleGuest },
];

const ORGANIZATION_ROLE_OPTIONS: Array<{ value: Exclude<OrganizationMemberRole, "owner">; label: string }> = [
  { value: "admin", label: LABELS.roleAdmin },
  { value: "security_admin", label: LABELS.roleSecurityAdmin },
  { value: "billing_admin", label: LABELS.roleBillingAdmin },
  { value: "member", label: LABELS.roleMember },
  { value: "guest", label: LABELS.roleGuest },
];

const WORKSPACE_CREATION_POLICY_OPTIONS: Array<{ value: WorkspaceCreationPolicy; label: string }> = [
  { value: "owners_admins", label: LABELS.policyOwnersAdmins },
  { value: "members", label: LABELS.policyMembers },
];

const SIGNUP_POLICY_OPTIONS: Array<{ value: SignupPolicy; label: string }> = [
  { value: "public", label: LABELS.signupPublic },
  { value: "closed", label: LABELS.signupClosed },
];

const DOMAIN_SIGNUP_POLICY_OPTIONS: Array<{ value: DomainSignupPolicy; label: string }> = [
  { value: "invite_only", label: LABELS.signupInviteOnly },
  { value: "verified_domains", label: LABELS.domainSignupVerified },
];

const SHARING_POLICY_OPTIONS: Array<{ key: OrganizationSharingPolicyKey; label: string }> = [
  { key: "publicWebSharing", label: LABELS.sharingPublicWeb },
  { key: "externalEmailSharing", label: LABELS.sharingExternalEmail },
  { key: "guestAccess", label: LABELS.sharingGuests },
  { key: "fileDownloads", label: LABELS.sharingFileDownloads },
  { key: "fullAccessGrants", label: LABELS.sharingFullAccess },
];

const AUDIT_ACTION_OPTIONS = [
  { value: "", label: LABELS.auditAllEvents },
  { value: "auth.login_attempt", label: LABELS.auditLoginAttempt },
  { value: "organization_settings.update", label: LABELS.auditSettingsUpdate },
  { value: "organization_member.deactivate", label: LABELS.auditMemberDeactivate },
  { value: "organization_member.reactivate", label: LABELS.auditMemberReactivate },
  { value: "organization_member.role_update", label: LABELS.auditMemberRoleUpdate },
  { value: "organization_member.remove", label: LABELS.auditMemberRemove },
  { value: "organization_owner.transfer", label: LABELS.auditOwnerTransfer },
  { value: "organization_domain.create", label: LABELS.auditDomainCreate },
  { value: "organization_domain.verify", label: LABELS.auditDomainVerify },
  { value: "organization_domain.remove", label: LABELS.auditDomainRemove },
  { value: "workspace.create", label: LABELS.auditWorkspaceCreate },
  { value: "workspace.delete", label: LABELS.auditWorkspaceDelete },
  { value: "workspace_owner.transfer", label: LABELS.auditWorkspaceOwnerTransfer },
  { value: "workspace_invitation.email_sent", label: LABELS.auditInviteEmailSent },
  { value: "workspace_invitation.email_failed", label: LABELS.auditInviteEmailFailed },
  { value: "workspace_invitation.email_not_configured", label: LABELS.auditInviteEmailNotConfigured },
  { value: "share.web_update", label: LABELS.auditWebShare },
  { value: "page_permission.grant", label: LABELS.auditPagePermissionGrant },
  { value: "page_permission.update", label: LABELS.auditPagePermissionUpdate },
  { value: "page_permission.revoke", label: LABELS.auditPagePermissionRevoke },
  { value: "export.page_markdown", label: LABELS.auditExportPage },
  { value: "export.database_csv", label: LABELS.auditExportDatabase },
  { value: "export.workspace_markdown", label: LABELS.auditExportWorkspace },
  { value: "page.delete", label: LABELS.auditPageDelete },
  { value: "database_row.delete", label: LABELS.auditDatabaseRowDelete },
];

function normalizeWorkspaceSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatBytes(bytes: number | undefined) {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes ?? 0) : 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatStorageLimitDraft(bytes: number | null | undefined) {
  if (!bytes || !Number.isFinite(bytes)) return "";
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(2).replace(/\.?0+$/, "");
}

function parseStorageLimitDraft(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const mb = Number(trimmed);
  if (!Number.isFinite(mb) || mb < 0) throw new Error(LABELS.storageLimitInvalid);
  const bytes = Math.floor(mb * 1024 * 1024);
  return bytes > 0 ? bytes : null;
}

function formatStorageDate(value: string | undefined | null) {
  if (!value) return LABELS.none;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return LABELS.none;
  return new Intl.DateTimeFormat(activeDateLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function workspaceUrlPrefix() {
  if (typeof window === "undefined") return "/workspace/";
  return `${window.location.origin.replace(/^https?:\/\//, "")}/workspace/`;
}

function securityErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/invalid.*totp|totp.*invalid|verification code|two-step|two-factor|mfa/i.test(message)) {
    return LABELS.totpCodeMismatch;
  }
  if (/invalid.*password|invalid credentials|password/i.test(message)) {
    return LABELS.codeOrPasswordMismatch;
  }
  if (/recovery/i.test(message)) {
    return LABELS.recoveryCodeMismatch;
  }
  return settingsErrorMessage(error, fallback);
}

function latestMaintenanceRun(runs: FileMaintenanceRun[] | undefined) {
  return [...(runs ?? [])].sort((a, b) =>
    String(b.startedAt ?? b.createdAt ?? "").localeCompare(String(a.startedAt ?? a.createdAt ?? ""))
  )[0];
}

function workspaceRoleLabel(role: string | undefined, isOwner: boolean) {
  if (isOwner || role === "owner") return LABELS.roleOwner;
  if (role === "admin") return LABELS.roleAdmin;
  if (role === "guest") return LABELS.roleGuest;
  return LABELS.roleMember;
}

function workspaceRoleValue(role: string | undefined): WorkspaceMember["role"] {
  if (role === "owner" || role === "admin" || role === "guest") return role;
  return "member";
}

function organizationRoleLabel(role: string | undefined, isOwner: boolean) {
  if (isOwner || role === "owner") return LABELS.roleOwner;
  if (role === "admin") return LABELS.roleAdmin;
  if (role === "security_admin") return LABELS.roleSecurityAdmin;
  if (role === "billing_admin") return LABELS.roleBillingAdmin;
  if (role === "guest") return LABELS.roleGuest;
  return LABELS.roleMember;
}

function organizationRoleValue(role: string | undefined): Exclude<OrganizationMemberRole, "owner"> {
  if (role === "admin" || role === "security_admin" || role === "billing_admin" || role === "guest") return role;
  return "member";
}

function organizationMemberStatus(member: OrganizationMember) {
  return (member.status ?? "active") === "deactivated" ? LABELS.statusDeactivated : LABELS.statusActive;
}

function organizationDomainStatus(domain: OrganizationDomain) {
  if (domain.status === "verified") return LABELS.statusVerified;
  if (domain.status === "rejected") return LABELS.statusRejected;
  return LABELS.statusPending;
}

function organizationAuditLabel(event: OrganizationAuditEvent) {
  return event.action
    .split(/[._-]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function organizationAuditDetail(event: OrganizationAuditEvent) {
  const metadata = event.metadata ?? {};
  const bits = [
    event.targetType ? LABELS.auditDetailTarget(event.targetType) : null,
    typeof metadata.domain === "string" ? metadata.domain : null,
    typeof metadata.email === "string" ? metadata.email : null,
    typeof metadata.method === "string" ? LABELS.auditDetailMethod(metadata.method.replace(/_/g, " ")) : null,
    typeof metadata.phase === "string" ? LABELS.auditDetailPhase(metadata.phase) : null,
    typeof metadata.outcome === "string" ? LABELS.auditDetailOutcome(metadata.outcome) : null,
    typeof metadata.role === "string" ? LABELS.auditDetailRole(metadata.role) : null,
    typeof metadata.principalType === "string" ? LABELS.auditDetailPrincipal(metadata.principalType) : null,
    typeof metadata.enabled === "boolean"
      ? LABELS.auditDetailEnabled(metadata.enabled ? LABELS.boolYes : LABELS.boolNo)
      : null,
    typeof metadata.pageCount === "number" ? LABELS.auditDetailPages(metadata.pageCount) : null,
    typeof metadata.rowCount === "number" ? LABELS.auditDetailRows(metadata.rowCount) : null,
    typeof metadata.deletedPageCount === "number" ? LABELS.auditDetailDeletedPages(metadata.deletedPageCount) : null,
    typeof metadata.storageLimitBytes === "number"
      ? LABELS.auditDetailLimit(formatBytes(metadata.storageLimitBytes))
      : metadata.storageLimitBytes === null
        ? LABELS.auditDetailLimitNone
        : null,
    event.actorId ? LABELS.auditDetailActor(event.actorId) : null,
  ].filter(Boolean);
  return bits.join(" · ") || LABELS.auditDetailFallback;
}

function serverAuditLabel(event: ServerAuditSummaryEvent) {
  const prefix = event.scope === "instance" ? LABELS.scopeServer : LABELS.scopeOrganization;
  const readable = event.action
    .split(/[._-]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
  return `${prefix} · ${readable || event.action}`;
}

function serverAuditDetail(event: ServerAuditSummaryEvent) {
  const metadata = event.metadata ?? {};
  const bits = [
    event.targetLabel,
    event.targetType ? LABELS.auditTarget(event.targetType) : null,
    event.targetId,
    event.workspaceId ? LABELS.auditWorkspaceRef(event.workspaceId) : null,
    event.actorId ? LABELS.auditActorRef(event.actorId) : null,
    typeof metadata.email === "string" ? metadata.email : null,
    typeof metadata.signupPolicy === "string" ? LABELS.auditSignupPolicyRef(metadata.signupPolicy) : null,
    typeof metadata.disabled === "boolean" ? LABELS.auditDisabledRef(metadata.disabled) : null,
    typeof metadata.revokedSessions === "boolean" && metadata.revokedSessions ? LABELS.auditSessionsRevoked : null,
  ].filter(Boolean);
  return bits.join(" · ") || event.action;
}

function importJobStatusLabel(status: string) {
  if (status === "completed") return LABELS.jobCompleted;
  if (status === "failed") return LABELS.jobFailed;
  if (status === "cancelled") return LABELS.jobCancelled;
  if (status === "discovering") return LABELS.jobDiscovering;
  if (status === "ready") return LABELS.jobReady;
  if (status === "queued") return LABELS.jobQueued;
  return status || LABELS.jobUnknown;
}

function healthStatusLabel(status: "ok" | "attention" | "missing") {
  if (status === "ok") return LABELS.healthOk;
  if (status === "attention") return LABELS.healthAttention;
  return LABELS.healthMissing;
}

function downloadJsonFile(filename: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function workspaceCreationPolicyValue(value: string | undefined): WorkspaceCreationPolicy {
  return value === "members" ? "members" : "owners_admins";
}

function workspaceCreationPolicyLabel(value: string | undefined) {
  const policy = workspaceCreationPolicyValue(value);
  return WORKSPACE_CREATION_POLICY_OPTIONS.find((option) => option.value === policy)?.label ?? LABELS.policyOwnersAdmins;
}

function signupPolicyValue(value: string | undefined): SignupPolicy {
  // Legacy restrictive policies map to the current "closed" (admin-provisioned)
  // mode; the backend already normalizes stored rows the same way.
  if (value === "closed" || value === "invite_only" || value === "verified_domains") return "closed";
  return "public";
}

function signupPolicyLabel(value: string | undefined) {
  const policy = signupPolicyValue(value);
  return SIGNUP_POLICY_OPTIONS.find((option) => option.value === policy)?.label ?? LABELS.signupPublic;
}

function domainSignupPolicyValue(value: string | undefined): DomainSignupPolicy {
  return value === "verified_domains" ? "verified_domains" : "invite_only";
}

function domainSignupPolicyLabel(value: string | undefined) {
  const policy = domainSignupPolicyValue(value);
  return DOMAIN_SIGNUP_POLICY_OPTIONS.find((option) => option.value === policy)?.label ?? LABELS.signupInviteOnly;
}

function organizationSharingPolicyAllows(
  organization: { sharingPolicy?: Record<string, unknown> | null } | null | undefined,
  key: OrganizationSharingPolicyKey,
) {
  const value = organization?.sharingPolicy?.[key];
  return typeof value === "boolean" ? value : true;
}

function memberDisplayName(member: WorkspaceMember, currentUserId: string | undefined) {
  return member.displayName?.trim() || member.email?.trim() || (member.userId === currentUserId ? LABELS.me : LABELS.member);
}

function memberSubtitle(member: WorkspaceMember, currentUserId: string | undefined) {
  if (member.email?.trim()) return member.userId === currentUserId ? `${member.email} · ${LABELS.me}` : member.email;
  return member.userId === currentUserId ? LABELS.me : member.userId;
}

function memberDirectoryText(member: WorkspaceMember, currentUserId: string | undefined) {
  return [
    memberDisplayName(member, currentUserId),
    memberSubtitle(member, currentUserId),
    member.email,
    member.userId,
    workspaceRoleLabel(member.role, false),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function instanceUserDirectoryText(user: InstanceAdminUser) {
  return [
    user.id,
    user.email,
    user.displayName,
    user.role,
    user.status,
    user.disabled ? LABELS.searchDisabledUser : LABELS.searchActiveUser,
    user.isInstanceAdmin ? LABELS.searchInstanceAdmin : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function organizationMemberDisplayName(member: OrganizationMember, currentUserId: string | undefined) {
  return member.displayName?.trim() || member.email?.trim() || (member.userId === currentUserId ? LABELS.me : LABELS.member);
}

function organizationMemberSubtitle(member: OrganizationMember, currentUserId: string | undefined) {
  if (member.email?.trim()) return member.userId === currentUserId ? `${member.email} · ${LABELS.me}` : member.email;
  return member.userId === currentUserId ? LABELS.me : member.userId;
}

function organizationProfileDirectoryText(profile: OrganizationProfile | undefined) {
  if (!profile) return "";
  return [
    profile.displayName,
    profile.email,
    profile.userId,
    profile.organizationRole,
    profile.status,
    ...profile.workspaceMemberships.flatMap((membership) => [
      membership.workspaceName,
      membership.workspaceDomain,
      membership.role,
    ]),
    ...profile.pendingInvitations.flatMap((invitation) => [
      invitation.workspaceName,
      invitation.workspaceDomain,
      invitation.email,
      invitation.role,
      invitation.status,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function organizationProfileSummary(profile: OrganizationProfile | undefined) {
  if (!profile) return "";
  const workspaceCount = profile.workspaceMemberships.length;
  const pendingCount = profile.pendingInvitations.length;
  const workspaceNames = profile.workspaceMemberships
    .slice(0, 2)
    .map((membership) => membership.workspaceName)
    .filter(Boolean);
  const counts = [
    LABELS.workspacesCount(workspaceCount),
    pendingCount ? LABELS.pendingInvitesCount(pendingCount) : null,
  ].filter(Boolean);
  return [...counts, ...workspaceNames].join(" · ");
}

function organizationDirectoryText(
  member: OrganizationMember,
  currentUserId: string | undefined,
  profile?: OrganizationProfile,
) {
  return [
    organizationMemberDisplayName(member, currentUserId),
    organizationMemberSubtitle(member, currentUserId),
    member.email,
    member.userId,
    organizationRoleLabel(member.role, false),
    organizationMemberStatus(member),
    organizationProfileDirectoryText(profile),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function firstTrimmed(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

type SettingsNavSection =
  | "preferences"
  | "account-security"
  | "mcp"
  | "server-overview"
  | "instance"
  | "server-workspaces"
  | "server-security"
  | "server-audit"
  | "server-jobs"
  | "server-usage"
  | "server-backup"
  | "server-system"
  | "workspace"
  | "people"
  | "workspace-security"
  | "organization"
  | "usage";

const ACCOUNT_CONSOLE_NAV_GROUPS = [
  {
    label: LABELS.navAccountGroup,
    items: [
      { section: "preferences", label: LABELS.navProfile, icon: UserIcon },
      { section: "account-security", label: LABELS.navAccountSecurity, icon: LockIcon },
      { section: "mcp", label: LABELS.navAiConnections, icon: GlobeIcon },
    ],
  },
] as const;

const WORKSPACE_ADMIN_NAV_GROUPS = [
  {
    label: LABELS.navWorkspaceGroup,
    items: [
      { section: "workspace", label: LABELS.navOverview, icon: GlobeIcon },
      { section: "people", label: LABELS.navWorkspaceMembers, icon: SharePeopleIcon },
      { section: "organization", label: LABELS.navPoliciesDomains, icon: UserIcon },
      { section: "usage", label: LABELS.navUsage, icon: Upload },
    ],
  },
  {
    label: LABELS.navSecurityGroup,
    items: [
      { section: "workspace-security", label: LABELS.navSharingSecurity, icon: LockIcon },
    ],
  },
] as const;

const SERVER_ADMIN_NAV_GROUPS = [
  {
    label: LABELS.navServerGroup,
    items: [
      { section: "server-overview", label: LABELS.navOverview, icon: GlobeIcon },
      { section: "instance", label: LABELS.navAccountsSignup, icon: GlobeIcon },
      { section: "server-workspaces", label: LABELS.navServerWorkspaces, icon: SharePeopleIcon },
      { section: "server-security", label: LABELS.navServerSecurity, icon: LockIcon },
      { section: "server-audit", label: LABELS.navAuditLog, icon: UserIcon },
      { section: "server-jobs", label: LABELS.navImports, icon: Upload },
      { section: "server-usage", label: LABELS.navUsageFiles, icon: Upload },
      { section: "server-backup", label: LABELS.navBackup, icon: Upload },
      { section: "server-system", label: LABELS.navSystem, icon: PaletteIcon },
    ],
  },
] as const;

type WorkspaceSettingsSurface = "account-console" | "settings" | "workspace-admin" | "server-admin";

export function WorkspaceSettingsDialog({
  surface = "account-console",
}: {
  surface?: WorkspaceSettingsSurface;
}) {
  const workspaceAdminSurface = surface === "workspace-admin";
  const serverAdminSurface = surface === "server-admin";
  const adminSurface = workspaceAdminSurface || serverAdminSurface;
  const renderedSurface = surface === "settings" ? "account-console" : surface;
  const { t } = useTranslation(["workspaceSettingsDialog", "common"]);
  const router = useRouter();
  const workspace = useStore((s) => s.workspace);
  const workspaces = useStore((s) => s.workspaces);
  const organization = useStore((s) => s.organization);
  const storeOrganizationMembers = useStore((s) => s.organizationMembers);
  const organizationGroups = useStore((s) => s.organizationGroups);
  const organizationProfiles = useStore((s) => s.organizationProfiles);
  const storeOrganizationDomains = useStore((s) => s.organizationDomains);
  const currentOrganizationMember = useStore((s) => s.currentOrganizationMember);
  const updateWorkspace = useStore((s) => s.updateWorkspace);
  const deleteWorkspace = useStore((s) => s.deleteWorkspace);
  const notify = useStore((s) => s.notify);
  const applyWorkspaceMembers = useStore((s) => s.applyWorkspaceMembers);
  const applyOrganizationDirectory = useStore((s) => s.applyOrganizationDirectory);
  const userId = useStore((s) => s.userId);
  const currentMember = useStore((s) => s.currentMember);
  const signedInUserId = firstTrimmed(userId, currentMember?.userId, currentOrganizationMember?.userId, currentUserId());
  const signedInEmail = currentUserEmail();
  const profileSeedDisplayName = firstTrimmed(
    currentMember?.displayName,
    currentOrganizationMember?.displayName,
  );
  const profileSeedEmail = firstTrimmed(
    currentMember?.email,
    currentOrganizationMember?.email,
    signedInEmail,
  );
  const profileSeedAvatar = firstTrimmed(currentMember?.avatar, currentOrganizationMember?.avatar);
  const [name, setName] = useState(workspace?.name ?? "");
  const [domain, setDomain] = useState(workspace?.domain ?? "");
  const [workspaceError, setWorkspaceError] = useState("");
  const [deleteWorkspaceConfirm, setDeleteWorkspaceConfirm] = useState("");
  const [deleteWorkspaceBusy, setDeleteWorkspaceBusy] = useState(false);
  const [deleteWorkspaceError, setDeleteWorkspaceError] = useState("");
  const [domainError, setDomainError] = useState("");
  const [domainBusy, setDomainBusy] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [fileReport, setFileReport] = useState<FileUsageReport | null>(null);
  const [organizationFileReport, setOrganizationFileReport] = useState<FileUsageReport | null>(null);
  const [fileReportLoading, setFileReportLoading] = useState(false);
  const [fileReportError, setFileReportError] = useState("");
  const [fileCleanupBusy, setFileCleanupBusy] = useState(false);
  const [storageLimitDraft, setStorageLimitDraft] = useState(
    formatStorageLimitDraft(organization?.storageLimitBytes),
  );
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberError, setMemberError] = useState("");
  const [memberBusy, setMemberBusy] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [organizationMembers, setOrganizationMembers] = useState<OrganizationMember[]>([]);
  const [organizationDomains, setOrganizationDomains] = useState<OrganizationDomain[]>([]);
  const [organizationAuditEvents, setOrganizationAuditEvents] = useState<OrganizationAuditEvent[]>([]);
  const [organizationLoading, setOrganizationLoading] = useState(false);
  const [organizationError, setOrganizationError] = useState("");
  const [organizationBusy, setOrganizationBusy] = useState("");
  const [instanceUsers, setInstanceUsers] = useState<InstanceAdminUser[]>([]);
  const [instanceAdmins, setInstanceAdmins] = useState<string[]>([]);
  const [serverOverview, setServerOverview] = useState<ServerOverviewSummary | null>(null);
  const [serverWorkspaces, setServerWorkspaces] = useState<ServerWorkspaceSummary[]>([]);
  const [serverSecurity, setServerSecurity] = useState<ServerSecuritySummary | null>(null);
  const [serverAuditEvents, setServerAuditEvents] = useState<ServerAuditSummaryEvent[]>([]);
  const [serverImportJobs, setServerImportJobs] = useState<ServerImportJobSummary[]>([]);
  const [serverUsage, setServerUsage] = useState<ServerUsageSummary | null>(null);
  const [serverBackup, setServerBackup] = useState<ServerBackupSummary | null>(null);
  const [serverSystem, setServerSystem] = useState<ServerSystemSummary | null>(null);
  const [instanceLoading, setInstanceLoading] = useState(false);
  const [instanceError, setInstanceError] = useState("");
  const [instanceBusy, setInstanceBusy] = useState("");
  const [instanceQuery, setInstanceQuery] = useState("");
  const [instanceSignupPolicy, setInstanceSignupPolicy] = useState<SignupPolicy>("public");
  const [serverWorkspaceQuery, setServerWorkspaceQuery] = useState("");
  const [serverAuditAction, setServerAuditAction] = useState("");
  const [serverJobStatus, setServerJobStatus] = useState("");
  const [newInstanceUserEmail, setNewInstanceUserEmail] = useState("");
  const [newInstanceUserDisplayName, setNewInstanceUserDisplayName] = useState("");
  const [newInstanceUserPassword, setNewInstanceUserPassword] = useState("");
  const [instanceTemporaryPassword, setInstanceTemporaryPassword] = useState("");
  const [organizationQuery, setOrganizationQuery] = useState("");
  const [organizationAuditAction, setOrganizationAuditAction] = useState("");
  const [organizationDomainDraft, setOrganizationDomainDraft] = useState("");
  const [organizationGroupDraft, setOrganizationGroupDraft] = useState("");
  const [organizationGroupEditDrafts, setOrganizationGroupEditDrafts] = useState<Record<string, string>>({});
  const [organizationGroupMemberDrafts, setOrganizationGroupMemberDrafts] = useState<Record<string, string>>({});
  const [organizationReassignmentDrafts, setOrganizationReassignmentDrafts] = useState<Record<string, string>>({});
  const [profileDisplayName, setProfileDisplayName] = useState(profileSeedDisplayName);
  const [profileEmail, setProfileEmail] = useState(profileSeedEmail);
  const [profileAvatar, setProfileAvatar] = useState(profileSeedAvatar);
  const [profileIconPickerOpen, setProfileIconPickerOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [securityLoading, setSecurityLoading] = useState(false);
  const [securityBusy, setSecurityBusy] = useState("");
  const [securityError, setSecurityError] = useState("");
  const [securityNotice, setSecurityNotice] = useState("");
  const [passwordCurrent, setPasswordCurrent] = useState("");
  const [passwordNew, setPasswordNew] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [mcpConnections, setMcpConnections] = useState<McpConnectionsResult | null>(null);
  const [mcpCreatedToken, setMcpCreatedToken] = useState<McpCreatedToken | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpBusy, setMcpBusy] = useState("");
  const [mcpError, setMcpError] = useState("");
  const [mcpNotice, setMcpNotice] = useState("");
  const [mfaFactors, setMfaFactors] = useState<MfaFactor[]>([]);
  const [mfaEnrollment, setMfaEnrollment] = useState<TotpEnrollment | null>(null);
  const [mfaSetupCode, setMfaSetupCode] = useState("");
  const [mfaDisableCode, setMfaDisableCode] = useState("");
  const [mfaRecoveryConfirm, setMfaRecoveryConfirm] = useState("");
  const [mfaRecoveryCodes, setMfaRecoveryCodes] = useState<string[]>([]);
  const [mfaQrCodeDataUrl, setMfaQrCodeDataUrl] = useState("");
  const [mfaQrCodeError, setMfaQrCodeError] = useState("");
  const [authSessions, setAuthSessions] = useState<AuthSession[]>([]);
  const [inviteRole, setInviteRole] = useState<WorkspaceMember["role"]>("member");
  const [memberAddQuery, setMemberAddQuery] = useState("");
  const [serverUserResults, setServerUserResults] = useState<ServerUserSummary[]>([]);
  const [selectedServerUser, setSelectedServerUser] = useState<ServerUserSummary | null>(null);
  const [canSearchServerUsers, setCanSearchServerUsers] = useState(false);
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] =
    useState<SettingsNavSection>(
      serverAdminSurface ? "server-overview" : workspaceAdminSurface ? "workspace" : "preferences",
    );
  const [themePref, setThemePref] = useTheme();
  const [languagePref, setLanguagePref] = useState(() => currentLanguagePreference());
  const titleId = useId();
  const workspaceSectionId = useId();
  const deleteWorkspaceSectionId = useId();
  const appearanceSectionId = useId();
  const profileSectionId = useId();
  const securitySectionId = useId();
  const mcpSectionId = useId();
  const instanceSectionId = useId();
  const membersSectionId = useId();
  const workspaceSecuritySectionId = useId();
  const organizationSectionId = useId();
  const storageSectionId = useId();
  const domainStatusId = useId();
  const iconLabelId = useId();
  const profileIconLabelId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const iconButtonRef = useRef<HTMLButtonElement>(null);
  const profileIconButtonRef = useRef<HTMLButtonElement>(null);
  const initialSectionHandledRef = useRef(false);
  const currentMemberRef = useRef(currentMember);
  const membersRef = useRef<WorkspaceMember[]>([]);

  useEffect(() => {
    currentMemberRef.current = currentMember;
  }, [currentMember]);

  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  const trimmedName = name.trim();
  const displayName = trimmedName || LABELS.untitledWorkspace;
  const isWorkspaceOwner = !!workspace?.ownerId && workspace.ownerId === userId;
  const accountLabel = workspaceRoleLabel(currentMember?.role, isWorkspaceOwner);
  const canManageWorkspace = isWorkspaceOwner || currentMember?.role === "owner" || currentMember?.role === "admin";
  const canDeleteWorkspace = canManageWorkspace && workspaces.length > 1;
  const canManageStorage = canManageWorkspace;
  const isOrganizationOwner = !!organization?.ownerId && organization.ownerId === userId;
  const organizationAccountLabel = organizationRoleLabel(currentOrganizationMember?.role, isOrganizationOwner);
  const currentOrganizationRole = isOrganizationOwner || currentOrganizationMember?.role === "owner"
    ? "owner"
    : organizationRoleValue(currentOrganizationMember?.role);
  const canManageOrganization =
    isOrganizationOwner ||
    currentOrganizationMember?.role === "owner" ||
    currentOrganizationMember?.role === "admin" ||
    currentOrganizationMember?.role === "security_admin" ||
    currentOrganizationMember?.role === "billing_admin";
  const canManageOrganizationPeople = currentOrganizationRole === "owner" || currentOrganizationRole === "admin";
  const canManageOrganizationSecurity =
    currentOrganizationRole === "owner" || currentOrganizationRole === "security_admin";
  const canManageOrganizationBilling =
    currentOrganizationRole === "owner" || currentOrganizationRole === "billing_admin";
  const canViewStorage = canManageStorage || canManageOrganizationBilling;
  const allowedSettingsSections = useMemo(() => {
    const sections: SettingsNavSection[] = adminSurface
      ? []
      : ["preferences", "account-security", "mcp"];
    if (serverAdminSurface) {
      sections.push(
        "server-overview",
        "instance",
        "server-workspaces",
        "server-security",
        "server-audit",
        "server-jobs",
        "server-usage",
        "server-backup",
        "server-system",
      );
    } else if (workspaceAdminSurface) {
      if (canManageWorkspace) sections.push("workspace", "people");
      if (canManageOrganizationSecurity) sections.push("workspace-security");
      if (canManageOrganization) sections.push("organization");
      if (canViewStorage) sections.push("usage");
    }
    return new Set(sections);
  }, [
    adminSurface,
    canManageOrganization,
    canManageOrganizationSecurity,
    canManageWorkspace,
    canViewStorage,
    serverAdminSurface,
    workspaceAdminSurface,
  ]);
  const fallbackSettingsSection = useMemo<SettingsNavSection>(() => {
    if (serverAdminSurface) return "server-overview";
    if (workspaceAdminSurface) {
      if (allowedSettingsSections.has("workspace")) return "workspace";
      if (allowedSettingsSections.has("people")) return "people";
      if (allowedSettingsSections.has("organization")) return "organization";
      if (allowedSettingsSections.has("workspace-security")) return "workspace-security";
      if (allowedSettingsSections.has("usage")) return "usage";
      return "workspace";
    }
    return "preferences";
  }, [allowedSettingsSections, serverAdminSurface, workspaceAdminSurface]);
  const visibleSettingsSection = allowedSettingsSections.has(activeSettingsSection)
    ? activeSettingsSection
    : fallbackSettingsSection;
  const noAdminAccess = adminSurface && allowedSettingsSections.size === 0;
  const renderCurrentSection = !noAdminAccess && allowedSettingsSections.has(visibleSettingsSection);
  const visibleSettingsNavGroups = useMemo(
    () =>
      (serverAdminSurface
        ? SERVER_ADMIN_NAV_GROUPS
        : workspaceAdminSurface
          ? WORKSPACE_ADMIN_NAV_GROUPS
          : ACCOUNT_CONSOLE_NAV_GROUPS
      ).map((group) => ({
        ...group,
        items: group.items.filter((item) => allowedSettingsSections.has(item.section)),
      })).filter((group) => group.items.length > 0),
    [allowedSettingsSections, serverAdminSurface, workspaceAdminSurface],
  );
  const workspaceCreationPolicy = workspaceCreationPolicyValue(organization?.workspaceCreationPolicy);
  const signupPolicy = instanceSignupPolicy;
  const domainSignupPolicy = domainSignupPolicyValue(organization?.domainSignupPolicy);
  const verifiedOrganizationDomainCount = organizationDomains.filter(
    (domainItem) => organizationDomainStatus(domainItem) === LABELS.statusVerified,
  ).length;
  const signupPolicyHelp =
    signupPolicy === "public" ? LABELS.signupHelpPublic : LABELS.signupHelpClosed;
  const organizationDomainPolicyLabel = verifiedOrganizationDomainCount
    ? domainSignupPolicy === "verified_domains"
      ? LABELS.domainPolicyVerifiedRequired
      : LABELS.domainPolicyInviteVerified
    : LABELS.domainPolicyAddHint;
  const memberInitial = displayName.trim().slice(0, 1).toUpperCase() || "W";
  const deleteWorkspaceTargetName = workspace?.name || displayName;
  const deleteWorkspaceConfirmMatches = deleteWorkspaceConfirm.trim() === deleteWorkspaceTargetName;

  useEffect(() => {
    if (initialSectionHandledRef.current) return;
    const section = new URL(window.location.href).searchParams.get("section");
    const targetSection: SettingsNavSection | null =
      serverAdminSurface && (section === "overview" || section === "server-overview")
        ? "server-overview"
        : section === "instance" || section === "accounts" || section === "users" || section === "signup"
        ? "instance"
        : serverAdminSurface && (section === "workspaces" || section === "server-workspaces")
          ? "server-workspaces"
        : serverAdminSurface && (section === "security" || section === "server-security")
          ? "server-security"
        : serverAdminSurface && (section === "audit" || section === "logs" || section === "server-audit")
          ? "server-audit"
        : serverAdminSurface && (section === "jobs" || section === "imports" || section === "server-jobs")
          ? "server-jobs"
        : serverAdminSurface && (section === "files" || section === "server-usage")
          ? "server-usage"
        : serverAdminSurface && (section === "backup" || section === "server-backup")
          ? "server-backup"
        : serverAdminSurface && (section === "system" || section === "settings" || section === "server-system")
          ? "server-system"
        : section === "members" || section === "people"
        ? "people"
        : section === "security"
          ? (adminSurface ? "workspace-security" : "account-security")
          : section === "sharing" || section === "workspace-security"
            ? "workspace-security"
          : section === "mcp" || section === "ai"
            ? "mcp"
            : section === "storage" || section === "usage"
              ? "usage"
              : section === "organization" || section === "domains" || section === "groups"
                ? "organization"
                : section === "workspace"
                  ? "workspace"
                  : null;
    initialSectionHandledRef.current = true;
    if (!targetSection) return;
    const nextSection = allowedSettingsSections.has(targetSection) ? targetSection : fallbackSettingsSection;
    setActiveSettingsSection(nextSection);
    if (nextSection === "people") setInvitePanelOpen(true);
  }, [adminSurface, allowedSettingsSections, fallbackSettingsSection, serverAdminSurface]);

  useEffect(() => {
    if (!allowedSettingsSections.has(activeSettingsSection)) {
      setActiveSettingsSection(fallbackSettingsSection);
    }
  }, [activeSettingsSection, allowedSettingsSections, fallbackSettingsSection]);

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [visibleSettingsSection]);

  async function saveName() {
    if (!workspace || !canManageWorkspace) return;
    const nextName = trimmedName || LABELS.untitledWorkspace;
    if (nextName !== workspace.name) {
      setWorkspaceError("");
      try {
        await updateWorkspace({ name: nextName });
      } catch (error) {
        setWorkspaceError(settingsErrorMessage(error, t("workspaceSettingsDialog:errUpdateWorkspace")));
        setName(workspace.name);
        return;
      }
    }
    setName(nextName);
  }

  async function saveDomain() {
    if (!workspace || !canManageWorkspace) return;
    const nextDomain = normalizeWorkspaceSlug(domain);
    setDomain(nextDomain);
    setDomainError("");
    if (nextDomain !== (workspace.domain ?? "")) {
      setDomainBusy(true);
      try {
        const updated = await updateWorkspace({ domain: nextDomain || undefined });
        setDomain(updated?.domain ?? "");
      } catch (error) {
        setDomain(workspace.domain ?? "");
        setDomainError(settingsErrorMessage(error, t("workspaceSettingsDialog:errUpdateWorkspaceUrl")));
      } finally {
        setDomainBusy(false);
      }
    }
  }

  function routeForWorkspace(target: { domain?: string | null } | undefined) {
    const slug = target?.domain?.trim();
    return slug ? `/workspace/${encodeURIComponent(slug)}` : "/";
  }

  async function submitDeleteWorkspace(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || deleteWorkspaceBusy) return;
    setDeleteWorkspaceError("");
    if (!canDeleteWorkspace) {
      setDeleteWorkspaceError(
        workspaces.length <= 1
          ? LABELS.lastWorkspaceError
          : LABELS.deleteAdminRequired,
      );
      return;
    }
    if (!deleteWorkspaceConfirmMatches) {
      setDeleteWorkspaceError(LABELS.deleteNameMismatch);
      return;
    }
    setDeleteWorkspaceBusy(true);
    try {
      const nextWorkspace = await deleteWorkspace(workspace.id, {
        confirmWorkspaceName: deleteWorkspaceConfirm.trim(),
      });
      notify(LABELS.workspaceDeleted, "success");
      router.replace(routeForWorkspace(nextWorkspace));
    } catch (error) {
      setDeleteWorkspaceError(settingsErrorMessage(error, LABELS.deleteWorkspaceFailed));
    } finally {
      setDeleteWorkspaceBusy(false);
    }
  }

  const refreshFileReport = useCallback(async () => {
    if (!workspace?.id || !canViewStorage) return;
    setFileReportLoading(true);
    setFileReportError("");
    try {
      const [workspaceReport, organizationReport] = await Promise.all([
        canManageStorage
          ? getFileUsageReportRemote({
              workspaceId: workspace.id,
              maintenanceLimit: 5,
            })
          : Promise.resolve(null),
        canManageOrganizationBilling && organization?.id
          ? getFileUsageReportRemote({
              organizationId: organization.id,
              maintenanceLimit: 5,
            })
          : Promise.resolve(null),
      ]);
      setFileReport(workspaceReport);
      setOrganizationFileReport(organizationReport);
    } catch (err) {
      setFileReportError(settingsErrorMessage(err, t("workspaceSettingsDialog:errLoadStorageReport")));
    } finally {
      setFileReportLoading(false);
    }
  }, [canManageOrganizationBilling, canManageStorage, canViewStorage, organization?.id, t, workspace?.id]);

  useEffect(() => {
    if (visibleSettingsSection !== "usage") return;
    void refreshFileReport();
  }, [refreshFileReport, visibleSettingsSection]);

  useEffect(() => {
    setProfileDisplayName(profileSeedDisplayName);
    setProfileEmail(profileSeedEmail);
    setProfileAvatar(profileSeedAvatar);
  }, [
    currentMember?.id,
    currentOrganizationMember?.id,
    profileSeedAvatar,
    profileSeedDisplayName,
    profileSeedEmail,
    signedInEmail,
  ]);

  useEffect(() => {
    setStorageLimitDraft(formatStorageLimitDraft(organization?.storageLimitBytes));
  }, [organization?.id, organization?.storageLimitBytes]);

  const applyInstanceAdminResult = useCallback((result: {
    instanceSettings?: { signupPolicy?: SignupPolicy | string; instanceAdminUserIds?: unknown };
    instanceAdmins?: string[];
    users?: InstanceAdminUser[];
    overview?: ServerOverviewSummary;
    workspaces?: ServerWorkspaceSummary[];
    security?: ServerSecuritySummary;
    auditEvents?: ServerAuditSummaryEvent[];
    importJobs?: ServerImportJobSummary[];
    usage?: ServerUsageSummary;
    backup?: ServerBackupSummary;
    system?: ServerSystemSummary;
    temporaryPassword?: string;
  }) => {
    setInstanceUsers(result.users ?? []);
    setInstanceAdmins(result.instanceAdmins ?? []);
    setServerOverview(result.overview ?? null);
    setServerWorkspaces(result.workspaces ?? []);
    setServerSecurity(result.security ?? null);
    setServerAuditEvents(result.auditEvents ?? []);
    setServerImportJobs(result.importJobs ?? []);
    setServerUsage(result.usage ?? null);
    setServerBackup(result.backup ?? null);
    setServerSystem(result.system ?? null);
    if (result.temporaryPassword) {
      setInstanceTemporaryPassword(result.temporaryPassword);
    }
    if (result.instanceSettings?.signupPolicy) {
      setInstanceSignupPolicy(signupPolicyValue(result.instanceSettings.signupPolicy));
    }
  }, []);

  const refreshInstanceAdmin = useCallback(async () => {
    if (!serverAdminSurface) return;
    setInstanceLoading(true);
    setInstanceError("");
    try {
      applyInstanceAdminResult(await getInstanceAdminRemote());
    } catch (err) {
      setInstanceError(settingsErrorMessage(err, t("workspaceSettingsDialog:errLoadInstanceUsers")));
    } finally {
      setInstanceLoading(false);
    }
  }, [applyInstanceAdminResult, serverAdminSurface, t]);

  useEffect(() => {
    if (!serverAdminSurface) return;
    void refreshInstanceAdmin();
  }, [refreshInstanceAdmin, serverAdminSurface, visibleSettingsSection]);

  // Server-account search for the member-add picker. Instance admins get live
  // results (name/email); a 403 means the caller is not an instance admin, so
  // the picker falls back to blind exact-email entry.
  useEffect(() => {
    if (!invitePanelOpen || !canManageWorkspace) return;
    let active = true;
    const query = memberAddQuery.trim();
    const handle = window.setTimeout(() => {
      searchServerUsersRemote(query, 8)
        .then((users) => {
          if (!active) return;
          setCanSearchServerUsers(true);
          setServerUserResults(users);
        })
        .catch(() => {
          if (!active) return;
          setCanSearchServerUsers(false);
          setServerUserResults([]);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(handle);
    };
  }, [invitePanelOpen, canManageWorkspace, memberAddQuery]);

  const refreshMembers = useCallback(async () => {
    if (!workspace?.id || !canManageWorkspace) {
      const fallbackMember = currentMemberRef.current;
      setMembers(fallbackMember ? [fallbackMember] : []);
      setMemberError("");
      return;
    }
    setMembersLoading(true);
    setMemberError("");
    try {
      const result = await getWorkspaceMembersRemote(workspace.id);
      const nextMembers = result.members ?? [];
      setMembers(nextMembers);
      applyWorkspaceMembers(nextMembers, result.currentMember);
      applyOrganizationDirectory(result);
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      if (result.instanceSettings?.signupPolicy) {
        setInstanceSignupPolicy(signupPolicyValue(result.instanceSettings.signupPolicy));
      }
    } catch (err) {
      if (shouldSuppressBackgroundSettingsError(
        err,
        membersRef.current.length > 0 || !!currentMemberRef.current,
      )) {
        setMemberError("");
      } else {
        setMemberError(settingsErrorMessage(err, t("workspaceSettingsDialog:errLoadMembers")));
      }
    } finally {
      setMembersLoading(false);
    }
  }, [
    applyOrganizationDirectory,
    applyWorkspaceMembers,
    canManageWorkspace,
    t,
    workspace?.id,
  ]);

  useEffect(() => {
    if (visibleSettingsSection !== "people") return;
    void refreshMembers();
  }, [refreshMembers, visibleSettingsSection]);

  useEffect(() => {
    setOrganizationMembers(canManageOrganization ? storeOrganizationMembers : []);
  }, [canManageOrganization, storeOrganizationMembers]);

  useEffect(() => {
    setOrganizationDomains(canManageOrganization ? storeOrganizationDomains : []);
  }, [canManageOrganization, storeOrganizationDomains]);

  useEffect(() => {
    setOrganizationGroupEditDrafts((drafts) => {
      const nextDrafts: Record<string, string> = {};
      for (const group of organizationGroups) {
        nextDrafts[group.id] = drafts[group.id] ?? group.name;
      }
      return nextDrafts;
    });
  }, [organizationGroups]);

  const refreshOrganizationDirectory = useCallback(async () => {
    if (!organization?.id || !canManageOrganization) {
      setOrganizationMembers([]);
      setOrganizationDomains([]);
      setOrganizationAuditEvents([]);
      setOrganizationError("");
      return;
    }
    setOrganizationLoading(true);
    setOrganizationError("");
    try {
      const result = await getOrganizationDirectoryRemote(organization.id);
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      if (result.instanceSettings?.signupPolicy) {
        setInstanceSignupPolicy(signupPolicyValue(result.instanceSettings.signupPolicy));
      }
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errLoadOrganization")));
    } finally {
      setOrganizationLoading(false);
    }
  }, [applyOrganizationDirectory, canManageOrganization, organization?.id, t]);

  useEffect(() => {
    if (visibleSettingsSection !== "organization" && visibleSettingsSection !== "workspace-security") return;
    void refreshOrganizationDirectory();
  }, [refreshOrganizationDirectory, visibleSettingsSection]);

  const refreshSecurity = useCallback(async () => {
    setSecurityLoading(true);
    setSecurityError("");
    try {
      const [factors, sessions] = await Promise.all([
        listMfaFactorsRemote(),
        listAuthSessionsRemote(),
      ]);
      setMfaFactors(factors);
      setAuthSessions(sessions);
    } catch (err) {
      setSecurityError(securityErrorMessage(err, LABELS.loadAccountSecurityFailed));
    } finally {
      setSecurityLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visibleSettingsSection !== "account-security") return;
    void refreshSecurity();
  }, [refreshSecurity, visibleSettingsSection]);

  const refreshMcpConnections = useCallback(async () => {
    setMcpLoading(true);
    setMcpError("");
    try {
      const result = await listMcpConnectionsRemote();
      setMcpConnections(result);
    } catch (err) {
      setMcpError(settingsErrorMessage(err, t("workspaceSettingsDialog:errLoadAiConnections")));
    } finally {
      setMcpLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (visibleSettingsSection !== "mcp") return;
    void refreshMcpConnections();
  }, [refreshMcpConnections, visibleSettingsSection]);

  useEffect(() => {
    let active = true;
    const uri = mfaEnrollment?.qrCodeUri;
    if (!uri) {
      setMfaQrCodeDataUrl("");
      setMfaQrCodeError("");
      return;
    }

    setMfaQrCodeDataUrl("");
    setMfaQrCodeError("");
    void QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 180,
      color: {
        dark: "#111111",
        light: "#ffffff",
      },
    })
      .then((dataUrl) => {
        if (active) setMfaQrCodeDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setMfaQrCodeError(LABELS.qrCodeFailed);
      });

    return () => {
      active = false;
    };
  }, [mfaEnrollment?.qrCodeUri]);

  async function cleanupExpiredUploads() {
    if (!workspace?.id || !canManageStorage) return;
    setFileCleanupBusy(true);
    setFileReportError("");
    try {
      await cleanupExpiredFileUploadsRemote({ workspaceId: workspace.id, limit: 200 });
      await refreshFileReport();
    } catch (err) {
      setFileReportError(settingsErrorMessage(err, t("workspaceSettingsDialog:errCleanupUploads")));
    } finally {
      setFileCleanupBusy(false);
    }
  }

  if (!workspace) return null;

  const fileTotals = fileReport?.totals;
  const organizationFileTotals = organizationFileReport?.totals;
  const pendingExpired = fileReport?.pending.expired ?? 0;
  const pendingActive = fileReport?.pending.active ?? 0;
  const latestRun = latestMaintenanceRun(fileReport?.maintenanceRuns);
  const organizationStorageLimit =
    organizationFileReport?.storageLimitBytes ?? organization?.storageLimitBytes ?? null;
  const topWorkspaces = [...(organizationFileReport?.byWorkspace ?? [])]
    .sort((a, b) => (b.totals?.activeStorageBytes ?? 0) - (a.totals?.activeStorageBytes ?? 0))
    .slice(0, 4);
  const topScopes = Object.entries(fileReport?.byScope ?? {})
    .sort((a, b) => (b[1]?.bytes ?? 0) - (a[1]?.bytes ?? 0))
    .slice(0, 4);
  const workspaceUrlPrefixValue = workspaceUrlPrefix();
  const renderedMembers = members.length ? members : currentMember ? [currentMember] : [];
  const accountEmailForDisplay = firstTrimmed(
    profileEmail,
    currentMember?.email,
    currentOrganizationMember?.email,
    signedInEmail,
  );
  const accountIdForDisplay = firstTrimmed(
    signedInUserId,
    currentMember?.userId,
    currentOrganizationMember?.userId,
  );
  const profileLabel = firstTrimmed(
    profileDisplayName,
    profileEmail,
    accountEmailForDisplay,
    accountIdForDisplay,
  ) || LABELS.me;
  const profileAvatarFallback = profileLabel.slice(0, 1).toUpperCase() || "Y";
  const profileRoleLabel = currentMember
    ? workspaceRoleLabel(currentMember.role, isWorkspaceOwner)
    : currentOrganizationMember
      ? organizationRoleLabel(currentOrganizationMember.role, isOrganizationOwner)
      : LABELS.myAccount;
  const mfaEnabled = mfaFactors.some((factor) => factor.type === "totp" && factor.verified !== false);
  const securitySummary = `${mfaEnabled ? LABELS.mfaOn : LABELS.mfaOff} · ${LABELS.activeSessionsCount(authSessions.length || 0)}`;
  const hasCurrentSessionMarker = authSessions.some((session) => session.current);
  const otherAuthSessions = hasCurrentSessionMarker
    ? authSessions.filter((session) => !session.current)
    : [];
  const normalizedInstanceQuery = instanceQuery.trim().toLowerCase();
  const filteredInstanceUsers = normalizedInstanceQuery
    ? instanceUsers.filter((user) => instanceUserDirectoryText(user).includes(normalizedInstanceQuery))
    : instanceUsers;
  const instanceUserSummary = normalizedInstanceQuery
    ? LABELS.peopleOfTotal(instanceUsers.length, filteredInstanceUsers.length)
    : LABELS.instanceUserTotals(instanceUsers.length, instanceAdmins.length);
  const disabledInstanceUserCount = instanceUsers.filter((user) => user.disabled).length;
  const verifiedInstanceUserCount = instanceUsers.filter((user) => user.verified).length;
  const serverCounts = serverOverview?.counts;
  const normalizedServerWorkspaceQuery = serverWorkspaceQuery.trim().toLowerCase();
  const filteredServerWorkspaces = normalizedServerWorkspaceQuery
    ? serverWorkspaces.filter((item) =>
        [
          item.name,
          item.domain,
          item.ownerId,
          item.organizationId,
          item.id,
        ].filter(Boolean).join(" ").toLowerCase().includes(normalizedServerWorkspaceQuery)
      )
    : serverWorkspaces;
  const serverWorkspaceSummaryText = normalizedServerWorkspaceQuery
    ? LABELS.itemsOfTotal(serverWorkspaces.length, filteredServerWorkspaces.length)
    : LABELS.workspacesCount(serverWorkspaces.length);
  const serverAuditActionOptions = [
    { value: "", label: LABELS.allActions },
    ...Array.from(new Set(serverAuditEvents.map((event) => event.action).filter(Boolean))).sort()
      .map((value) => ({ value, label: value })),
  ];
  const filteredServerAuditEvents = serverAuditAction
    ? serverAuditEvents.filter((event) => event.action === serverAuditAction)
    : serverAuditEvents;
  const serverJobStatusOptions = [
    { value: "", label: LABELS.allStatuses },
    ...Array.from(new Set(serverImportJobs.map((job) => job.status).filter(Boolean))).sort()
      .map((value) => ({ value, label: value })),
  ];
  const filteredServerImportJobs = serverJobStatus
    ? serverImportJobs.filter((job) => job.status === serverJobStatus)
    : serverImportJobs;
  const serverBackupTableEntries = Object.entries(serverBackup?.tableCounts ?? {})
    .sort((a, b) => a[0].localeCompare(b[0]));
  const normalizedMemberQuery = memberQuery.trim().toLowerCase();
  const filteredMembers = normalizedMemberQuery
    ? renderedMembers.filter((member) => memberDirectoryText(member, userId).includes(normalizedMemberQuery))
    : renderedMembers;
  const memberDirectorySummary = normalizedMemberQuery
    ? LABELS.peopleOfTotal(renderedMembers.length, filteredMembers.length)
    : LABELS.peopleCount(renderedMembers.length);
  const organizationDirectoryMembers =
    organizationMembers.length || !currentOrganizationMember
      ? organizationMembers
      : [currentOrganizationMember];
  const organizationProfilesByMember = new Map(
    organizationProfiles
      .filter((profile) => profile.organizationMemberId)
      .map((profile) => [profile.organizationMemberId, profile]),
  );
  const organizationProfilesByUser = new Map(
    organizationProfiles
      .filter((profile) => profile.userId)
      .map((profile) => [profile.userId, profile]),
  );
  const organizationProfilesByEmail = new Map(
    organizationProfiles
      .filter((profile) => profile.email)
      .map((profile) => [profile.email?.toLowerCase(), profile]),
  );
  const profileForOrganizationMember = (member: OrganizationMember) =>
    organizationProfilesByMember.get(member.id) ??
    organizationProfilesByUser.get(member.userId) ??
    organizationProfilesByEmail.get(member.email?.toLowerCase());
  const normalizedOrganizationQuery = organizationQuery.trim().toLowerCase();
  const filteredOrganizationMembers = normalizedOrganizationQuery
    ? organizationDirectoryMembers.filter((member) =>
        organizationDirectoryText(member, userId, profileForOrganizationMember(member)).includes(normalizedOrganizationQuery),
      )
    : organizationDirectoryMembers;
  const organizationDirectorySummary = normalizedOrganizationQuery
    ? LABELS.peopleOfTotal(organizationDirectoryMembers.length, filteredOrganizationMembers.length)
    : LABELS.orgMembersCount(organizationDirectoryMembers.length);
  const activeOrganizationMembers = organizationDirectoryMembers.filter(
    (member) => organizationMemberStatus(member) !== LABELS.statusDeactivated,
  );
  const organizationReassignmentCandidatesFor = (member: OrganizationMember) =>
    activeOrganizationMembers.filter(
      (candidate) =>
        candidate.id !== member.id &&
        candidate.userId !== member.userId &&
        candidate.role !== "guest",
    );
  const selectedOrganizationReassignmentMemberId = (member: OrganizationMember) => {
    const candidates = organizationReassignmentCandidatesFor(member);
    const drafted = organizationReassignmentDrafts[member.id];
    if (drafted && candidates.some((candidate) => candidate.id === drafted)) return drafted;
    if (
      currentOrganizationMember?.id &&
      candidates.some((candidate) => candidate.id === currentOrganizationMember.id)
    ) {
      return currentOrganizationMember.id;
    }
    return candidates[0]?.id ?? "";
  };
  const filteredOrganizationAuditEvents = organizationAuditAction
    ? organizationAuditEvents.filter((event) => event.action === organizationAuditAction)
    : organizationAuditEvents;

  function closeIconPicker() {
    setIconPickerOpen(false);
    window.requestAnimationFrame(() => iconButtonRef.current?.focus());
  }

  function closeProfileIconPicker() {
    setProfileIconPickerOpen(false);
    window.requestAnimationFrame(() => profileIconButtonRef.current?.focus());
  }

  function updateIcon(icon: string) {
    if (!canManageWorkspace) return;
    setWorkspaceError("");
    void updateWorkspace({ icon }).catch((error) => {
      setWorkspaceError(settingsErrorMessage(error, t("workspaceSettingsDialog:errUpdateWorkspaceIcon")));
    });
    closeIconPicker();
  }

  function updateProfileAvatar(icon: string | null) {
    setProfileAvatar(icon ?? "");
    setProfileError("");
    closeProfileIconPicker();
  }

  // Add a workspace member. Instance admins pick an existing server account
  // (userId) from the search results; anyone else types an exact email that the
  // server resolves to an existing account or blindly no-ops. No invitation
  // email is sent, and there is no pending-invitation state.
  async function addMember(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!workspace?.id || !canManageWorkspace) return;
    const emailInput = memberAddQuery.trim();
    if (!selectedServerUser) {
      if (!emailInput) {
        setMemberError(LABELS.memberEmailRequired);
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) {
        setMemberError(LABELS.memberEmailInvalid);
        return;
      }
    }
    setMemberBusy("addMember");
    setMemberError("");
    try {
      const result = await addWorkspaceMemberRemote(
        selectedServerUser
          ? { workspaceId: workspace.id, userId: selectedServerUser.id, role: inviteRole }
          : { workspaceId: workspace.id, email: emailInput, role: inviteRole },
      );
      const nextMembers = result.members ?? [];
      setMembers(nextMembers);
      applyWorkspaceMembers(nextMembers, result.currentMember);
      setMemberAddQuery("");
      setSelectedServerUser(null);
      setServerUserResults([]);
      setInviteRole("member");
      setInvitePanelOpen(false);
    } catch (err) {
      setMemberError(settingsErrorMessage(err, LABELS.memberAddFailed));
    } finally {
      setMemberBusy("");
    }
  }

  async function updateMemberRole(member: WorkspaceMember, role: WorkspaceMember["role"]) {
    if (!workspace?.id || !canManageWorkspace || workspaceRoleValue(member.role) === role) return;
    setMemberBusy(`role:${member.id}`);
    setMemberError("");
    try {
      const result = await updateWorkspaceMemberRoleRemote({
        workspaceId: workspace.id,
        memberId: member.id,
        role,
      });
      const nextMembers = result.members ?? [];
      setMembers(nextMembers);
      applyWorkspaceMembers(nextMembers, result.currentMember);
    } catch (err) {
      setMemberError(settingsErrorMessage(err, LABELS.memberRoleUpdateFailed));
    } finally {
      setMemberBusy("");
    }
  }

  async function transferWorkspaceOwner(member: WorkspaceMember) {
    if (!workspace?.id || !isWorkspaceOwner || member.userId === userId) return;
    setMemberBusy(`owner:${member.id}`);
    setMemberError("");
    try {
      const result = await transferWorkspaceOwnerRemote({
        workspaceId: workspace.id,
        memberId: member.id,
      });
      const nextMembers = result.members ?? [];
      setMembers(nextMembers);
      applyWorkspaceMembers(nextMembers, result.currentMember);
    } catch (err) {
      setMemberError(settingsErrorMessage(err, LABELS.ownerTransferFailed));
    } finally {
      setMemberBusy("");
    }
  }

  async function removeMember(member: WorkspaceMember) {
    if (!workspace?.id || !canManageWorkspace) return;
    setMemberBusy(`remove:${member.id}`);
    setMemberError("");
    try {
      const result = await removeWorkspaceMemberRemote({
        workspaceId: workspace.id,
        memberId: member.id,
      });
      const nextMembers = result.members ?? [];
      setMembers(nextMembers);
      applyWorkspaceMembers(nextMembers, result.currentMember);
    } catch (err) {
      setMemberError(settingsErrorMessage(err, LABELS.memberRemoveFailed));
    } finally {
      setMemberBusy("");
    }
  }

  async function updateOrganizationMemberStatus(member: OrganizationMember) {
    if (!organization?.id || !canManageOrganizationPeople) return;
    const deactivated = organizationMemberStatus(member) === LABELS.statusDeactivated;
    const busyKey = `${deactivated ? "reactivate" : "deactivate"}:${member.id}`;
    setOrganizationBusy(busyKey);
    setOrganizationError("");
    try {
      const result = deactivated
        ? await reactivateOrganizationMemberRemote(organization.id, member.id)
        : await deactivateOrganizationMemberRemote(organization.id, member.id);
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(
        settingsErrorMessage(err, `Could not ${deactivated ? "reactivate" : "deactivate"} member.`),
      );
    } finally {
      setOrganizationBusy("");
    }
  }

  async function removeOrganizationMember(member: OrganizationMember) {
    if (!organization?.id || !canManageOrganizationPeople) return;
    setOrganizationBusy(`remove:${member.id}`);
    setOrganizationError("");
    try {
      const reassignToOrganizationMemberId = selectedOrganizationReassignmentMemberId(member);
      const result = await removeOrganizationMemberRemote(organization.id, member.id, {
        reassignToOrganizationMemberId,
      });
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      setOrganizationReassignmentDrafts((drafts) => {
        const next = { ...drafts };
        delete next[member.id];
        return next;
      });
      applyOrganizationDirectory(result);
      await refreshMembers();
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errRemoveOrgMember")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function transferOrganizationOwner(member: OrganizationMember) {
    if (!organization?.id || !isOrganizationOwner) return;
    setOrganizationBusy(`owner:${member.id}`);
    setOrganizationError("");
    try {
      const result = await transferOrganizationOwnerRemote(organization.id, member.id);
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errTransferOrgOwnership")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function updateOrganizationRole(member: OrganizationMember, role: Exclude<OrganizationMemberRole, "owner">) {
    if (!organization?.id || !isOrganizationOwner) return;
    if (role === organizationRoleValue(member.role)) return;
    setOrganizationBusy(`org-role:${member.id}`);
    setOrganizationError("");
    try {
      const result = await updateOrganizationMemberRoleRemote(organization.id, member.id, role);
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errUpdateOrgRole")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function updateWorkspaceCreationPolicy(nextPolicy: WorkspaceCreationPolicy) {
    if (!organization?.id || !canManageOrganizationPeople || nextPolicy === workspaceCreationPolicy) return;
    setOrganizationBusy("policy:workspaceCreation");
    setOrganizationError("");
    try {
      const result = await updateOrganizationSettingsRemote({
        organizationId: organization.id,
        workspaceCreationPolicy: nextPolicy,
      });
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errUpdateOrgPolicy")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function updateSignupPolicy(nextPolicy: SignupPolicy) {
    if (nextPolicy === signupPolicy) return;
    setInstanceBusy("policy:signup");
    setInstanceError("");
    try {
      applyInstanceAdminResult(await updateInstanceSignupPolicyRemote(nextPolicy));
    } catch (err) {
      setInstanceError(settingsErrorMessage(err, t("workspaceSettingsDialog:errUpdateSignupPolicy")));
    } finally {
      setInstanceBusy("");
    }
  }

  async function setInstanceUserDisabled(user: InstanceAdminUser, disabled: boolean) {
    if (!user.id) return;
    setInstanceBusy(`disabled:${user.id}`);
    setInstanceError("");
    try {
      applyInstanceAdminResult(await setInstanceUserDisabledRemote(user.id, disabled));
    } catch (err) {
      setInstanceError(settingsErrorMessage(err, disabled ? t("workspaceSettingsDialog:errDisableUser") : t("workspaceSettingsDialog:errRestoreUser")));
    } finally {
      setInstanceBusy("");
    }
  }

  async function deleteInstanceUser(user: InstanceAdminUser) {
    if (!user.id) return;
    const label = user.email || user.displayName || user.id;
    if (!window.confirm(LABELS.confirmDeleteUser(label))) return;
    setInstanceBusy(`delete:${user.id}`);
    setInstanceError("");
    try {
      applyInstanceAdminResult(await deleteInstanceUserRemote(user.id));
    } catch (err) {
      setInstanceError(settingsErrorMessage(err, t("workspaceSettingsDialog:errDeleteUser")));
    } finally {
      setInstanceBusy("");
    }
  }

  async function setUserInstanceAdmin(user: InstanceAdminUser, enabled: boolean) {
    if (!user.id) return;
    setInstanceBusy(`admin:${user.id}`);
    setInstanceError("");
    try {
      applyInstanceAdminResult(await setInstanceAdminRemote(user.id, enabled));
    } catch (err) {
      setInstanceError(settingsErrorMessage(err, t("workspaceSettingsDialog:errUpdateInstanceAdmin")));
    } finally {
      setInstanceBusy("");
    }
  }

  async function createInstanceUser(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = newInstanceUserEmail.trim();
    if (!email) {
      setInstanceError(LABELS.enterEmail);
      return;
    }
    setInstanceBusy("user:create");
    setInstanceError("");
    setInstanceTemporaryPassword("");
    try {
      applyInstanceAdminResult(await createInstanceUserRemote({
        email,
        displayName: newInstanceUserDisplayName.trim() || undefined,
        password: newInstanceUserPassword.trim() || undefined,
      }));
      setNewInstanceUserEmail("");
      setNewInstanceUserDisplayName("");
      setNewInstanceUserPassword("");
    } catch (err) {
      setInstanceError(settingsErrorMessage(err, LABELS.createAccountFailed));
    } finally {
      setInstanceBusy("");
    }
  }

  async function resetInstanceUserPassword(user: InstanceAdminUser) {
    if (!user.id) return;
    const label = user.email || user.displayName || user.id;
    if (!window.confirm(LABELS.confirmResetPassword(label))) return;
    setInstanceBusy(`password:${user.id}`);
    setInstanceError("");
    setInstanceTemporaryPassword("");
    try {
      applyInstanceAdminResult(await resetInstanceUserPasswordRemote(user.id));
    } catch (err) {
      setInstanceError(settingsErrorMessage(err, LABELS.resetPasswordFailed));
    } finally {
      setInstanceBusy("");
    }
  }

  async function revokeInstanceUserSessions(user: InstanceAdminUser) {
    if (!user.id) return;
    const label = user.email || user.displayName || user.id;
    if (!window.confirm(LABELS.confirmRevokeSessions(label))) return;
    setInstanceBusy(`sessions:${user.id}`);
    setInstanceError("");
    try {
      applyInstanceAdminResult(await revokeInstanceUserSessionsRemote(user.id));
    } catch (err) {
      setInstanceError(settingsErrorMessage(err, LABELS.revokeSessionsFailed));
    } finally {
      setInstanceBusy("");
    }
  }

  async function downloadServerSnapshot() {
    setInstanceBusy("backup:snapshot");
    setInstanceError("");
    try {
      const snapshot = await createInstanceBackupSnapshotRemote();
      downloadJsonFile(
        `hanji-product-snapshot-${snapshot.generatedAt.replace(/[:.]/g, "-")}.json`,
        snapshot,
      );
      notify(LABELS.snapshotDownloaded);
      await refreshInstanceAdmin();
    } catch (err) {
      setInstanceError(settingsErrorMessage(err, LABELS.snapshotFailed));
    } finally {
      setInstanceBusy("");
    }
  }

  async function updateDomainSignupPolicy(nextPolicy: DomainSignupPolicy) {
    if (!organization?.id || !canManageOrganizationSecurity || nextPolicy === domainSignupPolicy) return;
    setOrganizationBusy("policy:domainSignup");
    setOrganizationError("");
    try {
      const result = await updateOrganizationSettingsRemote({
        organizationId: organization.id,
        domainSignupPolicy: nextPolicy,
      });
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errUpdateOrgPolicy")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function updateSharingPolicy(key: OrganizationSharingPolicyKey, value: boolean) {
    if (!organization?.id || !canManageOrganizationSecurity) return;
    setOrganizationBusy(`policy:sharing:${key}`);
    setOrganizationError("");
    try {
      const result = await updateOrganizationSettingsRemote({
        organizationId: organization.id,
        sharingPolicy: { [key]: value },
      });
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errUpdateOrgPolicy")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function saveOrganizationStorageLimit(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!organization?.id || !canManageOrganizationBilling) return;
    setOrganizationBusy("policy:storageLimit");
    setFileReportError("");
    try {
      const storageLimitBytes = parseStorageLimitDraft(storageLimitDraft);
      const result = await updateOrganizationSettingsRemote({
        organizationId: organization.id,
        storageLimitBytes,
      });
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
      setStorageLimitDraft(formatStorageLimitDraft(result.organization.storageLimitBytes));
      await refreshFileReport();
    } catch (err) {
      setFileReportError(settingsErrorMessage(err, t("workspaceSettingsDialog:errUpdateStorageLimit")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function createOrganizationGroup(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!organization?.id || !canManageOrganizationPeople) return;
    const name = organizationGroupDraft.trim();
    if (!name) {
      setOrganizationError(t("workspaceSettingsDialog:errGroupNameRequired"));
      return;
    }
    setOrganizationBusy("group:create");
    setOrganizationError("");
    try {
      const result = await createOrganizationGroupRemote({
        organizationId: organization.id,
        name,
      });
      setOrganizationGroupDraft("");
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errCreateOrgGroup")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function updateOrganizationGroup(
    group: OrganizationGroup,
    e?: ReactFormEvent<HTMLFormElement>,
  ) {
    e?.preventDefault();
    if (!organization?.id || !canManageOrganizationPeople) return;
    const name = (organizationGroupEditDrafts[group.id] ?? group.name).trim();
    if (!name) {
      setOrganizationError(t("workspaceSettingsDialog:errGroupNameRequired"));
      return;
    }
    if (name === group.name) return;
    setOrganizationBusy(`group:update:${group.id}`);
    setOrganizationError("");
    try {
      const result = await updateOrganizationGroupRemote({
        organizationId: organization.id,
        organizationGroupId: group.id,
        name,
      });
      setOrganizationGroupEditDrafts((drafts) => ({ ...drafts, [group.id]: name }));
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errUpdateOrgGroup")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function deleteOrganizationGroup(group: OrganizationGroup) {
    if (!organization?.id || !canManageOrganizationPeople) return;
    setOrganizationBusy(`group:delete:${group.id}`);
    setOrganizationError("");
    try {
      const result = await deleteOrganizationGroupRemote({
        organizationId: organization.id,
        organizationGroupId: group.id,
      });
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errDeleteOrgGroup")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function addOrganizationGroupMember(group: OrganizationGroup) {
    if (!organization?.id || !canManageOrganizationPeople) return;
    const organizationMemberId = organizationGroupMemberDrafts[group.id];
    if (!organizationMemberId) return;
    setOrganizationBusy(`group:add:${group.id}`);
    setOrganizationError("");
    try {
      const result = await addOrganizationGroupMemberRemote({
        organizationId: organization.id,
        organizationGroupId: group.id,
        organizationMemberId,
      });
      setOrganizationGroupMemberDrafts((drafts) => ({ ...drafts, [group.id]: "" }));
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errAddGroupMember")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function removeOrganizationGroupMember(
    group: OrganizationGroup,
    member: OrganizationGroupMember,
  ) {
    if (!organization?.id || !canManageOrganizationPeople) return;
    setOrganizationBusy(`group:remove:${member.id}`);
    setOrganizationError("");
    try {
      const result = await removeOrganizationGroupMemberRemote({
        organizationId: organization.id,
        organizationGroupId: group.id,
        organizationGroupMemberId: member.id,
      });
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errRemoveGroupMember")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function addOrganizationDomain(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!organization?.id || !canManageOrganizationSecurity) return;
    const domain = organizationDomainDraft.trim();
    if (!domain) {
      setOrganizationError(t("workspaceSettingsDialog:errDomainRequired"));
      return;
    }
    setOrganizationBusy("domain:add");
    setOrganizationError("");
    try {
      const result = await addOrganizationDomainRemote(organization.id, domain);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
      setOrganizationDomainDraft("");
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errAddDomain")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function verifyOrganizationDomain(domain: OrganizationDomain) {
    if (!organization?.id || !canManageOrganizationSecurity) return;
    setOrganizationBusy(`domain:verify:${domain.id}`);
    setOrganizationError("");
    try {
      const result = await verifyOrganizationDomainRemote(organization.id, domain.id);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errVerifyDomain")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function removeOrganizationDomain(domain: OrganizationDomain) {
    if (!organization?.id || !canManageOrganizationSecurity) return;
    setOrganizationBusy(`domain:remove:${domain.id}`);
    setOrganizationError("");
    try {
      const result = await removeOrganizationDomainRemote(organization.id, domain.id);
      setOrganizationDomains(result.organizationDomains ?? []);
      setOrganizationMembers(result.organizationMembers ?? []);
      setOrganizationAuditEvents(result.organizationAuditEvents ?? []);
      applyOrganizationDirectory(result);
    } catch (err) {
      setOrganizationError(settingsErrorMessage(err, t("workspaceSettingsDialog:errRemoveDomain")));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function saveProfile(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!workspace?.id) return;
    setProfileBusy(true);
    setProfileError("");
    try {
      const result = await updateMyWorkspaceProfileRemote({
        workspaceId: workspace.id,
        displayName: profileDisplayName.trim() || null,
        email: profileEmail.trim() || null,
        avatar: profileAvatar.trim() || null,
      });
      const nextMembers = result.members ?? [];
      const nextMember = result.currentMember ?? result.member;
      setMembers(nextMembers);
      applyWorkspaceMembers(nextMembers, nextMember);
      setProfileDisplayName(firstTrimmed(nextMember?.displayName, profileSeedDisplayName));
      setProfileEmail(firstTrimmed(nextMember?.email, signedInEmail));
      setProfileAvatar(firstTrimmed(nextMember?.avatar, profileSeedAvatar));
    } catch (err) {
      setProfileError(settingsErrorMessage(err, t("workspaceSettingsDialog:errUpdateProfile")));
    } finally {
      setProfileBusy(false);
    }
  }

  async function startTotpEnrollment() {
    setSecurityBusy("mfa:enroll");
    setSecurityError("");
    setSecurityNotice("");
    setMfaRecoveryCodes([]);
    try {
      const enrollment = await enrollTotpRemote();
      setMfaEnrollment(enrollment);
      setMfaSetupCode("");
    } catch (err) {
      setSecurityError(securityErrorMessage(err, LABELS.mfaEnrollFailed));
    } finally {
      setSecurityBusy("");
    }
  }

  async function verifyTotpSetup(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!mfaEnrollment) return;
    const code = mfaSetupCode.replace(/\D/g, "");
    if (code.length !== 6) {
      setSecurityError(LABELS.enterSixDigitCode);
      return;
    }
    setSecurityBusy("mfa:verify");
    setSecurityError("");
    setSecurityNotice("");
    try {
      await verifyTotpEnrollmentRemote(mfaEnrollment.factorId, code);
      setMfaRecoveryCodes(mfaEnrollment.recoveryCodes ?? []);
      setMfaEnrollment(null);
      setMfaSetupCode("");
      setSecurityNotice(LABELS.mfaEnabledNotice);
      await refreshSecurity();
    } catch (err) {
      setSecurityError(securityErrorMessage(err, LABELS.mfaVerifyFailed));
    } finally {
      setSecurityBusy("");
    }
  }

  async function disableTotp(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = mfaDisableCode.trim();
    if (!value) {
      setSecurityError(LABELS.enterCodeOrPassword);
      return;
    }
    setSecurityBusy("mfa:disable");
    setSecurityError("");
    setSecurityNotice("");
    try {
      await disableTotpRemote(/^\d{6}$/.test(value) ? { code: value } : { password: value });
      setMfaDisableCode("");
      setMfaRecoveryCodes([]);
      setSecurityNotice(LABELS.mfaDisabledNotice);
      await refreshSecurity();
    } catch (err) {
      setSecurityError(securityErrorMessage(err, LABELS.mfaDisableFailed));
    } finally {
      setSecurityBusy("");
    }
  }

  async function regenerateRecoveryCodes(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = mfaRecoveryConfirm.trim();
    if (!value) {
      setSecurityError(LABELS.enterCodeOrPassword);
      return;
    }
    setSecurityBusy("mfa:recovery-codes");
    setSecurityError("");
    setSecurityNotice("");
    try {
      const codes = await regenerateRecoveryCodesRemote(/^\d{6}$/.test(value) ? { code: value } : { password: value });
      setMfaRecoveryConfirm("");
      setMfaRecoveryCodes(codes);
      setSecurityNotice(LABELS.recoveryRegeneratedNotice);
      await refreshSecurity();
    } catch (err) {
      setSecurityError(securityErrorMessage(err, LABELS.recoveryRegenerateFailed));
    } finally {
      setSecurityBusy("");
    }
  }

  async function changePassword(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    const currentPassword = passwordCurrent;
    const nextPassword = passwordNew;
    if (!currentPassword.trim() || !nextPassword.trim()) {
      setSecurityError(LABELS.enterCurrentAndNewPassword);
      return;
    }
    if (nextPassword.length < 8) {
      setSecurityError(LABELS.newPasswordTooShort);
      return;
    }
    if (nextPassword !== passwordConfirm) {
      setSecurityError(LABELS.newPasswordMismatch);
      return;
    }
    setSecurityBusy("password:change");
    setSecurityError("");
    setSecurityNotice("");
    try {
      await changePasswordRemote({ currentPassword, newPassword: nextPassword });
      setPasswordCurrent("");
      setPasswordNew("");
      setPasswordConfirm("");
      setSecurityNotice(LABELS.passwordChangedNotice);
      await refreshSecurity();
    } catch (err) {
      setSecurityError(securityErrorMessage(err, LABELS.passwordChangeFailed));
    } finally {
      setSecurityBusy("");
    }
  }

  async function copySecurityText(value: string, notice: string) {
    if (!value.trim()) return;
    setSecurityError("");
    try {
      await navigator.clipboard.writeText(value);
      setSecurityNotice(notice);
    } catch (err) {
      setSecurityError(settingsErrorMessage(err, LABELS.clipboardCopyFailed));
    }
  }

  async function copyMcpText(value: string, notice: string) {
    if (!value.trim()) return;
    setMcpError("");
    try {
      await navigator.clipboard.writeText(value);
      setMcpNotice(notice);
    } catch (err) {
      setMcpError(settingsErrorMessage(err, LABELS.clipboardCopyFailed));
    }
  }

  async function createManualMcpToken() {
    setMcpBusy("manual-token");
    setMcpError("");
    setMcpNotice("");
    setMcpCreatedToken(null);
    try {
      const result = await createManualMcpTokenRemote();
      setMcpConnections(result);
      setMcpCreatedToken(result.createdToken ?? null);
      setMcpNotice(LABELS.manualTokenCreated);
    } catch (err) {
      setMcpError(settingsErrorMessage(err, t("workspaceSettingsDialog:errCreateMcpToken")));
    } finally {
      setMcpBusy("");
    }
  }

  async function revokeMcpGrant(grantId: string) {
    setMcpBusy(`revoke:${grantId}`);
    setMcpError("");
    setMcpNotice("");
    try {
      const result = await revokeMcpConnectionRemote(grantId);
      setMcpConnections(result);
      setMcpNotice(LABELS.aiConnectionRevoked);
    } catch (err) {
      setMcpError(settingsErrorMessage(err, t("workspaceSettingsDialog:errRevokeMcpConnection")));
    } finally {
      setMcpBusy("");
    }
  }

  function downloadRecoveryCodes() {
    if (!mfaRecoveryCodes.length) return;
    const blob = new Blob([`${mfaRecoveryCodes.join("\n")}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "hanji-recovery-codes.txt";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setSecurityNotice(LABELS.recoveryFileCreated);
  }

  async function revokeSession(session: AuthSession) {
    if (session.current) {
      setSecurityError(t("workspaceSettingsDialog:errUseSignOut"));
      return;
    }
    setSecurityBusy(`session:${session.id}`);
    setSecurityError("");
    setSecurityNotice("");
    try {
      await revokeAuthSessionRemote(session.id);
      setSecurityNotice(t("workspaceSettingsDialog:noticeSessionRevoked"));
      await refreshSecurity();
    } catch (err) {
      setSecurityError(settingsErrorMessage(err, t("workspaceSettingsDialog:errRevokeSession")));
    } finally {
      setSecurityBusy("");
    }
  }

  async function revokeOtherSessions() {
    if (!hasCurrentSessionMarker) {
      setSecurityError(t("workspaceSettingsDialog:errRefreshSessionsFirst"));
      return;
    }
    if (!otherAuthSessions.length) {
      setSecurityNotice(t("workspaceSettingsDialog:noticeNoOtherSessions"));
      return;
    }
    setSecurityBusy("sessions:others");
    setSecurityError("");
    setSecurityNotice("");
    try {
      await Promise.all(otherAuthSessions.map((session) => revokeAuthSessionRemote(session.id)));
      setSecurityNotice(`Revoked ${otherAuthSessions.length} other ${otherAuthSessions.length === 1 ? "session" : "sessions"}.`);
      await refreshSecurity();
    } catch (err) {
      setSecurityError(settingsErrorMessage(err, t("workspaceSettingsDialog:errRevokeOtherSessions")));
    } finally {
      setSecurityBusy("");
    }
  }

  function selectSettingsSection(section: SettingsNavSection) {
    if (!allowedSettingsSections.has(section)) return;
    setActiveSettingsSection(section);
  }

  function onDialogKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.defaultPrevented) return;
    if (!isComposingKeyEvent(e) && e.key === "Escape" && profileIconPickerOpen) {
      e.preventDefault();
      closeProfileIconPicker();
      return;
    }
    if (!isComposingKeyEvent(e) && e.key === "Escape" && iconPickerOpen) {
      e.preventDefault();
      closeIconPicker();
    }
  }

  const surfaceTitle = serverAdminSurface
    ? LABELS.serverConsole
    : workspaceAdminSurface
      ? LABELS.workspaceConsole
      : LABELS.accountConsole;
  const surfaceSubtitle = serverAdminSurface
    ? LABELS.serverConsoleSubtitle
    : workspaceAdminSurface
      ? LABELS.workspaceConsoleSubtitle
      : LABELS.accountConsoleSubtitle;
  const navAccountName = serverAdminSurface
    ? LABELS.hanjiServer
    : workspaceAdminSurface
      ? displayName
      : profileLabel;
  const navAccountRole = serverAdminSurface
    ? LABELS.instanceLabel
    : workspaceAdminSurface
      ? accountLabel
      : accountEmailForDisplay || accountIdForDisplay || LABELS.myAccount;

  return (
    <div className={styles.adminPage} role="region" aria-label={surfaceTitle}>
      <section
        ref={dialogRef}
        className={`${styles.dialog} ${styles.adminConsole}`}
        data-surface={renderedSurface}
        aria-labelledby={titleId}
        onKeyDown={onDialogKeyDown}
      >
        <nav
          className={styles.nav}
          aria-label={t("workspaceSettingsDialog:ariaSettingsNavigation", { title: surfaceTitle })}
        >
          <div className={styles.account}>
            <span className={styles.accountIcon} aria-hidden="true">
              {serverAdminSurface ? (
                <GlobeIcon size={18} />
              ) : workspaceAdminSurface ? (
                <WorkspaceIconGlyph icon={workspace.icon} size={20} />
              ) : (
                <WorkspaceIconGlyph icon={profileAvatar} size={20} fallback={profileAvatarFallback} />
              )}
            </span>
            <span className={styles.accountText}>
              <strong>{navAccountName}</strong>
              <span>{navAccountRole}</span>
            </span>
          </div>
          {visibleSettingsNavGroups.map((group) => (
            <div key={group.label} className={styles.navGroup}>
              <div className={styles.navGroupLabel}>{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.section}
                    type="button"
                    className={styles.navItem}
                    data-active={visibleSettingsSection === item.section ? "true" : undefined}
                    aria-current={visibleSettingsSection === item.section ? "page" : undefined}
                    onClick={() => selectSettingsSection(item.section)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div ref={panelRef} className={styles.panel}>
          <header className={styles.header}>
            <div className={styles.headerTitle}>
              <h2 id={titleId}>{surfaceTitle}</h2>
              {surfaceSubtitle ? (
                <span>{surfaceSubtitle}</span>
              ) : null}
            </div>
          </header>

          {noAdminAccess ? (
            <section className={styles.section} aria-labelledby={organizationSectionId}>
              <div id={organizationSectionId} className={styles.sectionTitle}>
                {LABELS.adminRequired}
              </div>
              <div className={styles.notice} data-tone="neutral">
                {LABELS.adminOnlyNotice}
              </div>
            </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "server-overview" ? (
          <section id="server-overview" className={styles.section} aria-labelledby={instanceSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={instanceSectionId} className={styles.sectionTitle}>
                  {LABELS.serverOverviewTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.serverOverviewMeta}
                </div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshInstanceAdmin()}
                  disabled={instanceLoading || !!instanceBusy}
                >
                  {LABELS.refresh}
                </button>
              </div>
            </div>

            {instanceError ? <div className={styles.notice}>{instanceError}</div> : null}

            <div className={styles.storageGrid} aria-busy={instanceLoading || !!instanceBusy}>
              <div className={styles.metricTile}>
                <span>{LABELS.accountsTile}</span>
                <strong>{serverCounts?.users ?? instanceUsers.length}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.workspacesTile}</span>
                <strong>{serverCounts?.workspaces ?? serverWorkspaces.length}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.pagesDbsTile}</span>
                <strong>{(serverCounts?.pages ?? 0) + (serverCounts?.databases ?? 0)}</strong>
              </div>
              <div className={styles.metricTile} data-attention={(serverCounts?.failedImportJobs ?? 0) > 0 ? "true" : undefined}>
                <span>{LABELS.failedImportsTile}</span>
                <strong>{serverCounts?.failedImportJobs ?? 0}</strong>
              </div>
            </div>

            <div className={styles.storageRows}>
              <div className={styles.storageRow}>
                <span>{LABELS.activeUsers}</span>
                <strong>{serverCounts?.activeUsers ?? instanceUsers.filter((user) => !user.disabled).length}</strong>
              </div>
              <div className={styles.storageRow}>
                <span>{LABELS.instanceAdminsTile}</span>
                <strong>{serverCounts?.instanceAdmins ?? instanceAdmins.length}</strong>
              </div>
              <div className={styles.storageRow}>
                <span>{LABELS.activeStorageTile}</span>
                <strong>{formatBytes(serverCounts?.activeStorageBytes)}</strong>
              </div>
              <div className={styles.storageRow}>
                <span>{LABELS.lastUpdated}</span>
                <strong>{formatStorageDate(serverOverview?.generatedAt)}</strong>
              </div>
            </div>

            {serverOverview?.health.length ? (
              <div className={styles.auditBlock}>
                <div className={styles.organizationSubhead}>
                  <span>{LABELS.operationalStatus}</span>
                  <strong>{serverOverview.health.length}</strong>
                </div>
                <div className={styles.auditList}>
                  {serverOverview.health.map((item) => (
                    <div key={item.key} className={styles.auditRow}>
                      <span className={styles.auditText}>
                        <strong>{item.label} · {healthStatusLabel(item.status)}</strong>
                        <span>{item.detail}</span>
                      </span>
                      <span className={styles.memberRole}>{healthStatusLabel(item.status)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className={styles.emptyState}>
                {instanceLoading ? LABELS.loadingServerStatus : LABELS.noServerStatus}
              </div>
            )}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "instance" ? (
          <section id="instance" className={styles.section} aria-labelledby={instanceSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={instanceSectionId} className={styles.sectionTitle}>
                  {LABELS.instanceTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.instanceMeta}
                </div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshInstanceAdmin()}
                  disabled={instanceLoading || !!instanceBusy}
                >
                  {LABELS.refresh}
                </button>
              </div>
            </div>

            {instanceError ? <div className={styles.notice}>{instanceError}</div> : null}

            <div className={styles.storageGrid} aria-label={t("workspaceSettingsDialog:ariaServerAccountSummary")}>
              <div className={styles.metricTile}>
                <span>{LABELS.allAccountsTile}</span>
                <strong>{instanceUsers.length}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.instanceAdminsTile}</span>
                <strong>{instanceAdmins.length}</strong>
              </div>
              <div className={styles.metricTile} data-attention={disabledInstanceUserCount > 0 ? "true" : undefined}>
                <span>{LABELS.disabledAccountsTile}</span>
                <strong>{disabledInstanceUserCount}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.verifiedAccountsTile}</span>
                <strong>{verifiedInstanceUserCount}</strong>
              </div>
            </div>

            <div className={styles.organizationPolicyBlock}>
              <div className={styles.organizationSubhead}>
                <span>{LABELS.signupTitle}</span>
                <strong>{signupPolicyLabel(signupPolicy)}</strong>
              </div>
              <div className={styles.policyOptions} role="radiogroup" aria-label={t("workspaceSettingsDialog:ariaInstanceSignupPolicy")}>
                {SIGNUP_POLICY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={styles.policyOption}
                    role="radio"
                    aria-checked={signupPolicy === option.value}
                    data-active={signupPolicy === option.value ? "true" : undefined}
                    disabled={instanceBusy === "policy:signup"}
                    onClick={() => void updateSignupPolicy(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className={styles.fieldMessage}>{signupPolicyHelp}</div>
            </div>

            <form className={styles.memberInvite} onSubmit={createInstanceUser}>
              <input
                value={newInstanceUserEmail}
                placeholder={LABELS.newAccountEmailPlaceholder}
                aria-label={t("workspaceSettingsDialog:ariaNewInstanceUserEmail")}
                type="email"
                autoComplete="off"
                disabled={instanceBusy === "user:create"}
                onChange={(e) => setNewInstanceUserEmail(e.target.value)}
              />
              <input
                value={newInstanceUserDisplayName}
                placeholder={LABELS.namePlaceholder}
                aria-label={t("workspaceSettingsDialog:ariaNewInstanceUserName")}
                autoComplete="off"
                disabled={instanceBusy === "user:create"}
                onChange={(e) => setNewInstanceUserDisplayName(e.target.value)}
              />
              <input
                value={newInstanceUserPassword}
                placeholder={LABELS.newAccountPasswordPlaceholder}
                aria-label={t("workspaceSettingsDialog:ariaNewInstanceUserPassword")}
                type="password"
                autoComplete="new-password"
                disabled={instanceBusy === "user:create"}
                onChange={(e) => setNewInstanceUserPassword(e.target.value)}
              />
              <button
                type="submit"
                className={styles.secondaryButton}
                disabled={instanceBusy === "user:create"}
              >
                {LABELS.createAccount}
              </button>
            </form>

            {instanceTemporaryPassword ? (
              <div className={styles.notice} data-tone="neutral">
                {LABELS.temporaryPasswordPrefix} <code>{instanceTemporaryPassword}</code>
                <button
                  type="button"
                  className={styles.memberAction}
                  onClick={() => void copySecurityText(instanceTemporaryPassword, LABELS.temporaryPasswordCopied)}
                >
                  {LABELS.copy}
                </button>
              </div>
            ) : null}

            <div className={styles.memberDirectoryTools}>
              <label className={styles.memberSearch}>
                <Search size={15} aria-hidden="true" />
                <input
                  value={instanceQuery}
                  aria-label={t("workspaceSettingsDialog:ariaSearchInstanceUsers")}
                  placeholder={LABELS.searchAccountsPlaceholder}
                  autoComplete="off"
                  onChange={(e) => setInstanceQuery(e.target.value)}
                />
              </label>
              <span className={styles.memberDirectoryCount}>{instanceUserSummary}</span>
            </div>

            <div className={styles.memberList} aria-busy={instanceLoading || !!instanceBusy}>
              {filteredInstanceUsers.map((user) => {
                const label = user.displayName?.trim() || user.email?.trim() || user.id;
                const isSelf = user.id === userId;
                return (
                  <div key={user.id} className={styles.memberRow}>
                    <span className={styles.memberAvatar} aria-hidden="true">
                      {label.trim().slice(0, 1).toUpperCase() || "U"}
                    </span>
                    <span className={styles.memberText}>
                      <strong>{label}</strong>
                      <span>
                        {(user.email || user.id)}
                        {user.disabled ? ` · ${LABELS.statusDeactivated}` : ` · ${LABELS.statusActive}`}
                        {user.isInstanceAdmin ? ` · ${LABELS.instanceAdminBadge}` : ""}
                        {LABELS.userScopeCounts(user.workspaceCount, user.organizationCount)}
                      </span>
                    </span>
                    <span className={styles.memberControls}>
                      {user.verified ? <span className={styles.memberRole}>{LABELS.statusVerified}</span> : null}
                      <button
                        type="button"
                        className={styles.memberAction}
                        disabled={isSelf || instanceBusy === `admin:${user.id}`}
                        onClick={() => void setUserInstanceAdmin(user, !user.isInstanceAdmin)}
                      >
                        {user.isInstanceAdmin ? LABELS.removeAdmin : LABELS.makeAdmin}
                      </button>
                      <button
                        type="button"
                        className={styles.memberAction}
                        disabled={isSelf || instanceBusy === `disabled:${user.id}`}
                        onClick={() => void setInstanceUserDisabled(user, !user.disabled)}
                      >
                        {user.disabled ? LABELS.restore : LABELS.deactivate}
                      </button>
                      <button
                        type="button"
                        className={styles.memberAction}
                        disabled={isSelf || instanceBusy === `delete:${user.id}`}
                        onClick={() => void deleteInstanceUser(user)}
                      >
                        {LABELS.delete}
                      </button>
                    </span>
                  </div>
                );
              })}

              {instanceLoading && instanceUsers.length === 0 ? (
                <div className={styles.emptyState}>{LABELS.loadingAccounts}</div>
              ) : null}
            </div>

            {!instanceLoading && filteredInstanceUsers.length === 0 ? (
              <div className={styles.emptyState}>
                {normalizedInstanceQuery ? LABELS.noSearchResults : LABELS.noInstanceAccounts}
              </div>
            ) : null}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "server-workspaces" ? (
          <section id="server-workspaces" className={styles.section} aria-labelledby={workspaceSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={workspaceSectionId} className={styles.sectionTitle}>
                  {LABELS.serverWorkspacesTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.serverWorkspacesMeta}
                </div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshInstanceAdmin()}
                  disabled={instanceLoading || !!instanceBusy}
                >
                  {LABELS.refresh}
                </button>
              </div>
            </div>

            {instanceError ? <div className={styles.notice}>{instanceError}</div> : null}

            <div className={styles.memberDirectoryTools}>
              <label className={styles.memberSearch}>
                <Search size={15} aria-hidden="true" />
                <input
                  value={serverWorkspaceQuery}
                  aria-label={t("workspaceSettingsDialog:ariaSearchServerWorkspaces")}
                  placeholder={LABELS.searchWorkspacesPlaceholder}
                  autoComplete="off"
                  onChange={(e) => setServerWorkspaceQuery(e.target.value)}
                />
              </label>
              <span className={styles.memberDirectoryCount}>{serverWorkspaceSummaryText}</span>
            </div>

            <div className={styles.memberList} aria-busy={instanceLoading || !!instanceBusy}>
              {filteredServerWorkspaces.slice(0, 80).map((item) => (
                <div key={item.id} className={styles.memberRow}>
                  <span className={styles.memberAvatar} aria-hidden="true">
                    {(item.name || item.domain || "W").trim().slice(0, 1).toUpperCase()}
                  </span>
                  <span className={styles.memberText}>
                    <strong>{item.name || item.domain || LABELS.untitledWorkspace}</strong>
                    <span>
                      {item.domain || item.id}
                      {LABELS.workspaceMemberCounts(item.memberCount, item.pageCount, item.databaseCount)}
                    </span>
                  </span>
                  <span className={styles.memberControls}>
                    <span className={styles.memberRole}>{formatBytes(item.activeStorageBytes)}</span>
                    {item.failedImportJobCount > 0 ? (
                      <span className={styles.memberRole}>{LABELS.importFailures(item.failedImportJobCount)}</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>

            {!instanceLoading && filteredServerWorkspaces.length === 0 ? (
              <div className={styles.emptyState}>
                {normalizedServerWorkspaceQuery ? LABELS.noSearchResults : LABELS.noWorkspaces}
              </div>
            ) : null}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "server-security" ? (
          <section id="server-security" className={styles.section} aria-labelledby={securitySectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={securitySectionId} className={styles.sectionTitle}>
                  {LABELS.serverSecurityTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.serverSecurityMeta}
                </div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshInstanceAdmin()}
                  disabled={instanceLoading || !!instanceBusy}
                >
                  {LABELS.refresh}
                </button>
              </div>
            </div>

            {instanceError ? <div className={styles.notice}>{instanceError}</div> : null}

            <div className={styles.storageGrid}>
              <div className={styles.metricTile}>
                <span>{LABELS.instanceAdminsTile}</span>
                <strong>{serverSecurity?.instanceAdmins ?? instanceAdmins.length}</strong>
              </div>
              <div className={styles.metricTile} data-attention={(serverSecurity?.disabledUsers ?? disabledInstanceUserCount) > 0 ? "true" : undefined}>
                <span>{LABELS.disabledAccountsTile}</span>
                <strong>{serverSecurity?.disabledUsers ?? disabledInstanceUserCount}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.sessionRevocationTile}</span>
                <strong>{serverSecurity?.sessionRevocationAvailable ? LABELS.available : LABELS.unavailable}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.mfaResetTile}</span>
                <strong>{serverSecurity?.mfaResetAvailable ? LABELS.available : LABELS.awaiting}</strong>
              </div>
            </div>

            {serverSecurity?.notes.length ? (
              <div className={styles.emptyState}>
                {serverSecurity.notes.join(" ")}
              </div>
            ) : null}

            <div className={styles.memberList} aria-busy={instanceLoading || !!instanceBusy}>
              {instanceUsers.map((user) => {
                const label = user.displayName?.trim() || user.email?.trim() || user.id;
                const isSelf = user.id === userId;
                return (
                  <div key={`security-${user.id}`} className={styles.memberRow} data-muted={user.disabled ? "true" : undefined}>
                    <span className={styles.memberAvatar} aria-hidden="true">
                      {label.trim().slice(0, 1).toUpperCase() || "U"}
                    </span>
                    <span className={styles.memberText}>
                      <strong>{label}</strong>
                      <span>
                        {(user.email || user.id)}
                        {user.disabled ? ` · ${LABELS.statusDeactivated}` : ` · ${LABELS.statusActive}`}
                        {user.isInstanceAdmin ? ` · ${LABELS.instanceAdminBadge}` : ""}
                      </span>
                    </span>
                    <span className={styles.memberControls}>
                      <button
                        type="button"
                        className={styles.memberAction}
                        disabled={isSelf || instanceBusy === `sessions:${user.id}`}
                        onClick={() => void revokeInstanceUserSessions(user)}
                      >
                        {LABELS.revokeSessionsButton}
                      </button>
                      <button
                        type="button"
                        className={styles.memberAction}
                        disabled={isSelf || instanceBusy === `password:${user.id}`}
                        onClick={() => void resetInstanceUserPassword(user)}
                      >
                        {LABELS.temporaryPasswordButton}
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "server-audit" ? (
          <section id="server-audit" className={styles.section} aria-labelledby={organizationSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={organizationSectionId} className={styles.sectionTitle}>
                  {LABELS.serverAuditTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.serverAuditMeta}
                </div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshInstanceAdmin()}
                  disabled={instanceLoading || !!instanceBusy}
                >
                  {LABELS.refresh}
                </button>
              </div>
            </div>

            {instanceError ? <div className={styles.notice}>{instanceError}</div> : null}

            <div className={styles.auditTools}>
              <select
                value={serverAuditAction}
                aria-label={t("workspaceSettingsDialog:ariaFilterServerAudit")}
                onChange={(event) => setServerAuditAction(event.target.value)}
              >
                {serverAuditActionOptions.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {filteredServerAuditEvents.length ? (
              <div className={styles.auditList}>
                {filteredServerAuditEvents.map((event) => (
                  <div key={`${event.scope}-${event.id}`} className={styles.auditRow}>
                    <span className={styles.auditText}>
                      <strong>{serverAuditLabel(event)}</strong>
                      <span>{serverAuditDetail(event)}</span>
                    </span>
                    <time dateTime={event.occurredAt}>{formatStorageDate(event.occurredAt)}</time>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.emptyState}>
                {instanceLoading ? LABELS.loadingAuditLog : LABELS.noAuditLog}
              </div>
            )}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "server-jobs" ? (
          <section id="server-jobs" className={styles.section} aria-labelledby={storageSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={storageSectionId} className={styles.sectionTitle}>
                  {LABELS.serverJobsTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.serverJobsMeta}
                </div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshInstanceAdmin()}
                  disabled={instanceLoading || !!instanceBusy}
                >
                  {LABELS.refresh}
                </button>
              </div>
            </div>

            {instanceError ? <div className={styles.notice}>{instanceError}</div> : null}

            <div className={styles.auditTools}>
              <select
                value={serverJobStatus}
                aria-label={t("workspaceSettingsDialog:ariaFilterImportJobs")}
                onChange={(event) => setServerJobStatus(event.target.value)}
              >
                {serverJobStatusOptions.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {filteredServerImportJobs.length ? (
              <div className={styles.auditList}>
                {filteredServerImportJobs.map((job) => (
                  <div key={job.id} className={styles.auditRow}>
                    <span className={styles.auditText}>
                      <strong>
                        {job.workspaceName || job.workspaceId} · {importJobStatusLabel(job.status)}
                      </strong>
                      <span>
                        {job.phase}
                        {LABELS.jobItemCounts(job.itemCount, job.mappedItemCount)}
                        {job.failedItemCount ? LABELS.jobFailedItems(job.failedItemCount) : ""}
                        {job.error ? ` · ${job.error}` : ""}
                      </span>
                    </span>
                    <time dateTime={job.updatedAt || job.finishedAt || job.createdAt || ""}>
                      {formatStorageDate(job.updatedAt || job.finishedAt || job.createdAt)}
                    </time>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.emptyState}>
                {instanceLoading ? LABELS.loadingImportJobs : LABELS.noImportJobs}
              </div>
            )}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "server-usage" ? (
          <section id="server-usage" className={styles.section} aria-labelledby={storageSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={storageSectionId} className={styles.sectionTitle}>
                  {LABELS.serverUsageTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.serverUsageMeta}
                </div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshInstanceAdmin()}
                  disabled={instanceLoading || !!instanceBusy}
                >
                  {LABELS.refresh}
                </button>
              </div>
            </div>

            {instanceError ? <div className={styles.notice}>{instanceError}</div> : null}

            <div className={styles.storageGrid}>
              <div className={styles.metricTile}>
                <span>{LABELS.activeStorageTile}</span>
                <strong>{formatBytes(serverUsage?.totals.activeStorageBytes)}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.filesTile}</span>
                <strong>{serverUsage?.totals.files ?? 0}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.pendingTile}</span>
                <strong>{serverUsage?.pending.active ?? 0}</strong>
              </div>
              <div className={styles.metricTile} data-attention={(serverUsage?.pending.expired ?? 0) > 0 ? "true" : undefined}>
                <span>{LABELS.expiredTile}</span>
                <strong>{serverUsage?.pending.expired ?? 0}</strong>
              </div>
            </div>

            {serverUsage?.byWorkspace.length ? (
              <div className={styles.scopeList}>
                {serverUsage.byWorkspace.map((item) => (
                  <div key={item.workspaceId} className={styles.scopeRow}>
                    <span>{item.workspaceName || item.workspaceId}</span>
                    <strong>{LABELS.fileCount(item.files)} · {formatBytes(item.activeStorageBytes)}</strong>
                  </div>
                ))}
              </div>
            ) : null}

            {serverUsage?.recentMaintenanceRuns.length ? (
              <div className={styles.auditBlock}>
                <div className={styles.organizationSubhead}>
                  <span>{LABELS.recentCleanup}</span>
                  <strong>{serverUsage.recentMaintenanceRuns.length}</strong>
                </div>
                <div className={styles.auditList}>
                  {serverUsage.recentMaintenanceRuns.map((run) => (
                    <div key={run.id} className={styles.auditRow}>
                      <span className={styles.auditText}>
                        <strong>{run.workspaceName || run.workspaceId} · {run.status || "unknown"}</strong>
                        <span>
                          {LABELS.maintenanceRunSummary(run.scanned ?? 0, run.expired ?? 0, run.failedObjects ?? 0)}
                        </span>
                      </span>
                      <time dateTime={run.startedAt || ""}>{formatStorageDate(run.startedAt)}</time>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "server-backup" ? (
          <section id="server-backup" className={styles.section} aria-labelledby={storageSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={storageSectionId} className={styles.sectionTitle}>
                  {LABELS.backupTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.serverBackupMeta}
                </div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void downloadServerSnapshot()}
                  disabled={instanceLoading || instanceBusy === "backup:snapshot"}
                >
                  {LABELS.downloadSnapshot}
                </button>
              </div>
            </div>

            {instanceError ? <div className={styles.notice}>{instanceError}</div> : null}

            <div className={styles.storageGrid}>
              <div className={styles.metricTile}>
                <span>{LABELS.downloadableTables}</span>
                <strong>{serverBackup?.downloadableTables.length ?? 0}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.restoreUiTile}</span>
                <strong>{serverBackup?.restoreAvailable ? LABELS.available : LABELS.onHold}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.lastGenerated}</span>
                <strong>{formatStorageDate(serverBackup?.generatedAt)}</strong>
              </div>
              <div className={styles.metricTile}>
                <span>{LABELS.snapshotScope}</span>
                <strong>{LABELS.productData}</strong>
              </div>
            </div>

            {serverBackup?.notes.length ? (
              <div className={styles.emptyState}>{serverBackup.notes.join(" ")}</div>
            ) : null}

            {serverBackupTableEntries.length ? (
              <div className={styles.scopeList}>
                {serverBackupTableEntries.map(([table, count]) => (
                  <div key={table} className={styles.scopeRow}>
                    <span>{table}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "server-system" ? (
          <section id="server-system" className={styles.section} aria-labelledby={appearanceSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={appearanceSectionId} className={styles.sectionTitle}>
                  {LABELS.serverSystemTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.serverSystemMeta}
                </div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshInstanceAdmin()}
                  disabled={instanceLoading || !!instanceBusy}
                >
                  {LABELS.refresh}
                </button>
              </div>
            </div>

            {instanceError ? <div className={styles.notice}>{instanceError}</div> : null}

            {serverSystem?.environment.length ? (
              <div className={styles.auditList}>
                {serverSystem.environment.map((item) => (
                  <div key={item.key} className={styles.auditRow}>
                    <span className={styles.auditText}>
                      <strong>{item.label}</strong>
                      <span>{item.detail}</span>
                    </span>
                    <span className={styles.memberRole}>{item.configured ? LABELS.configured : LABELS.notConfigured}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.emptyState}>
                {instanceLoading ? LABELS.loadingSystem : LABELS.noSystemSummary}
              </div>
            )}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "workspace" ? (
          <section id="workspace" className={styles.section} aria-labelledby={workspaceSectionId}>
            <div id={workspaceSectionId} className={styles.sectionTitle}>
              {LABELS.workspaceSectionTitle}
            </div>
            {workspaceError ? <div className={styles.notice}>{workspaceError}</div> : null}
            <label className={styles.field}>
              <span>{LABELS.nameField}</span>
              <input
                ref={nameInputRef}
                value={name}
                aria-label={t("workspaceSettingsDialog:ariaWorkspaceName")}
                disabled={!canManageWorkspace}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (isComposingKeyEvent(e)) return;
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
              />
            </label>

            <div className={styles.field}>
              <span>{LABELS.workspaceUrlField}</span>
              <div className={styles.fieldBody}>
                <div
                  className={styles.urlField}
                  data-invalid={domainError ? "true" : undefined}
                  data-busy={domainBusy ? "true" : undefined}
                >
                  <span className={styles.urlPrefix} title={workspaceUrlPrefixValue}>
                    {workspaceUrlPrefixValue}
                  </span>
                  <input
                    value={domain}
                    aria-label={t("workspaceSettingsDialog:ariaWorkspaceUrl")}
                    aria-describedby={domainError || domainBusy ? domainStatusId : undefined}
                    aria-invalid={domainError ? "true" : undefined}
                    disabled={!canManageWorkspace || domainBusy}
                    spellCheck={false}
                    placeholder={t("workspaceSettingsDialog:placeholderWorkspaceName")}
                    onChange={(e) => {
                      setDomain(e.target.value);
                      if (domainError) setDomainError("");
                    }}
                    onBlur={() => void saveDomain()}
                    onKeyDown={(e) => {
                      if (isComposingKeyEvent(e)) return;
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      }
                    }}
                  />
                </div>
                {domainError ? (
                  <div id={domainStatusId} className={styles.fieldMessage} data-tone="error" role="alert">
                    {domainError}
                  </div>
                ) : domainBusy ? (
                  <div id={domainStatusId} className={styles.fieldMessage}>
                    {LABELS.workspaceUrlSaving}
                  </div>
                ) : null}
              </div>
            </div>

            <div className={styles.fieldGroup} role="group" aria-labelledby={iconLabelId}>
              <span id={iconLabelId}>{LABELS.iconField}</span>
              <div
                className={styles.iconPickerWrap}
                onKeyDown={(e) => {
                  if (e.key !== "Escape" || !iconPickerOpen) return;
                  e.preventDefault();
                  e.stopPropagation();
                  closeIconPicker();
                }}
              >
                <button
                  ref={iconButtonRef}
                  type="button"
                  className={styles.iconPickerButton}
                  aria-haspopup="dialog"
                  aria-expanded={iconPickerOpen}
                  aria-label={t("workspaceSettingsDialog:ariaChangeWorkspaceIcon")}
                  disabled={!canManageWorkspace}
                  onClick={() => {
                    setProfileIconPickerOpen(false);
                    setIconPickerOpen((current) => !current);
                  }}
                >
                  <span className={styles.iconPreview} aria-hidden="true">
                    <WorkspaceIconGlyph icon={workspace.icon} size={28} />
                  </span>
                  <span>{LABELS.changeIcon}</span>
                </button>
                {iconPickerOpen && (
                  <EmojiPicker
                    placement="inline"
                    onPick={updateIcon}
                    onPickImage={updateIcon}
                    onRemove={() => updateIcon("📓")}
                    onClose={closeIconPicker}
                  />
                )}
              </div>
            </div>

            <div className={styles.dangerZone} aria-labelledby={deleteWorkspaceSectionId}>
              <div className={styles.dangerHeader}>
                <div>
                  <strong id={deleteWorkspaceSectionId}>{LABELS.deleteWorkspace}</strong>
                  <span>{LABELS.deleteWorkspaceDesc}</span>
                </div>
              </div>
              <form className={styles.dangerForm} onSubmit={submitDeleteWorkspace}>
                <label className={styles.dangerConfirmField}>
                  <span>{LABELS.deleteWorkspaceConfirmLabel}</span>
                  <input
                    value={deleteWorkspaceConfirm}
                    aria-label={LABELS.deleteConfirmAriaLabel}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={deleteWorkspaceTargetName}
                    disabled={!canDeleteWorkspace || deleteWorkspaceBusy}
                    onChange={(event) => {
                      setDeleteWorkspaceConfirm(event.target.value);
                      if (deleteWorkspaceError) setDeleteWorkspaceError("");
                    }}
                  />
                </label>
                {deleteWorkspaceError ? (
                  <div className={styles.fieldMessage} data-tone="error" role="alert">
                    {deleteWorkspaceError}
                  </div>
                ) : !canDeleteWorkspace ? (
                  <div className={styles.fieldMessage}>
                    {workspaces.length <= 1
                      ? LABELS.needAnotherWorkspace
                      : LABELS.onlyAdminsDelete}
                  </div>
                ) : null}
                <button
                  type="submit"
                  className={styles.dangerButton}
                  disabled={!canDeleteWorkspace || !deleteWorkspaceConfirmMatches || deleteWorkspaceBusy}
                >
                  {deleteWorkspaceBusy ? LABELS.deleting : LABELS.deleteWorkspace}
                </button>
              </form>
            </div>
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "preferences" ? (
          <>
          <section id="preferences" className={styles.section} aria-labelledby={appearanceSectionId}>
            <div id={appearanceSectionId} className={styles.sectionTitle}>
              {LABELS.preferencesTitle}
            </div>
            <div className={styles.field}>
              <span>{LABELS.themeField}</span>
              <div className={styles.themeOptions} role="radiogroup" aria-label={t("workspaceSettingsDialog:ariaTheme")}>
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={styles.themeOption}
                    role="radio"
                    aria-checked={themePref === option.value}
                    data-active={themePref === option.value ? "true" : undefined}
                    onClick={() => setThemePref(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.field}>
              <span>{LABELS.languageField}</span>
              <div
                className={styles.languageOptions}
                role="radiogroup"
                aria-label={t("workspaceSettingsDialog:ariaLanguage")}
              >
                {[
                  { value: "system", label: LABELS.languageSystem },
                  ...LANGUAGE_OPTIONS,
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={styles.languageOption}
                    role="radio"
                    aria-checked={languagePref === option.value}
                    data-active={languagePref === option.value ? "true" : undefined}
                    onClick={() => {
                      setLanguagePreference(option.value);
                      setLanguagePref(option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <SupportSection />
          </section>

          <section id="profile" className={styles.section} aria-labelledby={profileSectionId}>
            <div id={profileSectionId} className={styles.sectionTitle}>
              {LABELS.navProfile}
            </div>

            {profileError ? <div className={styles.notice}>{profileError}</div> : null}

            <div className={styles.profilePreview}>
              <span className={styles.profileAvatar} aria-hidden="true">
                <WorkspaceIconGlyph icon={profileAvatar} size={32} fallback={profileAvatarFallback} />
              </span>
              <span className={styles.profileText}>
                <strong>{profileLabel}</strong>
                <span>{profileRoleLabel}</span>
                {accountEmailForDisplay ? (
                  <span className={styles.profileIdentityRow}>
                    <span>{LABELS.accountEmail}</span>
                    <code>{accountEmailForDisplay}</code>
                  </span>
                ) : null}
                {accountIdForDisplay ? (
                  <span className={styles.profileIdentityRow}>
                    <span>{LABELS.accountId}</span>
                    <code>{accountIdForDisplay}</code>
                  </span>
                ) : null}
              </span>
            </div>

            <div className={styles.fieldGroup} role="group" aria-labelledby={profileIconLabelId}>
              <span id={profileIconLabelId}>{LABELS.profileIconField}</span>
              <div
                className={styles.iconPickerWrap}
                onKeyDown={(e) => {
                  if (e.key !== "Escape" || !profileIconPickerOpen) return;
                  e.preventDefault();
                  e.stopPropagation();
                  closeProfileIconPicker();
                }}
              >
                <button
                  ref={profileIconButtonRef}
                  type="button"
                  className={styles.iconPickerButton}
                  aria-haspopup="dialog"
                  aria-expanded={profileIconPickerOpen}
                  aria-label={t("workspaceSettingsDialog:ariaChangeProfileIcon")}
                  onClick={() => {
                    setIconPickerOpen(false);
                    setProfileIconPickerOpen((current) => !current);
                  }}
                >
                  <span className={styles.iconPreview} aria-hidden="true">
                    <WorkspaceIconGlyph icon={profileAvatar} size={28} fallback={profileAvatarFallback} />
                  </span>
                  <span>{LABELS.changeIcon}</span>
                </button>
                {profileIconPickerOpen && (
                  <EmojiPicker
                    placement="inline"
                    onPick={updateProfileAvatar}
                    onPickImage={updateProfileAvatar}
                    onRemove={() => updateProfileAvatar(null)}
                    onClose={closeProfileIconPicker}
                  />
                )}
              </div>
            </div>

            <form className={styles.profileForm} onSubmit={saveProfile}>
              <input
                value={profileDisplayName}
                aria-label={t("workspaceSettingsDialog:ariaProfileDisplayName")}
                placeholder={LABELS.displayNamePlaceholder}
                autoComplete="name"
                onChange={(e) => setProfileDisplayName(e.target.value)}
              />
              <input
                value={profileEmail}
                aria-label={t("workspaceSettingsDialog:ariaProfileEmail")}
                placeholder={LABELS.emailPlaceholder}
                type="email"
                autoComplete="email"
                onChange={(e) => setProfileEmail(e.target.value)}
              />
              <button type="submit" className={styles.primaryButton} disabled={profileBusy}>
                {LABELS.saveProfileButton}
              </button>
            </form>
          </section>
          </>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "account-security" ? (
          <section id="account-security" className={styles.section} aria-labelledby={securitySectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={securitySectionId} className={styles.sectionTitle}>
                  {LABELS.navAccountSecurity}
                </div>
                <div className={styles.organizationMeta}>{securitySummary}</div>
              </div>
              <div className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void refreshSecurity()}
                  disabled={securityLoading || !!securityBusy}
                >
                  {LABELS.refresh}
                </button>
              </div>
            </div>

            {securityError ? <div className={styles.notice}>{securityError}</div> : null}
            {securityNotice ? <div className={styles.notice} data-tone="neutral">{securityNotice}</div> : null}

            <div className={styles.securityPanel}>
              <div className={styles.securityRow}>
                <div className={styles.securityInstruction}>
                  <strong>{LABELS.passwordTitle}</strong>
                  <span>{LABELS.passwordDesc}</span>
                </div>
              </div>
              <form className={styles.passwordChangeForm} onSubmit={changePassword}>
                <label>
                  <span>{LABELS.currentPassword}</span>
                  <input
                    value={passwordCurrent}
                    aria-label={t("workspaceSettingsDialog:ariaCurrentPassword")}
                    type="password"
                    autoComplete="current-password"
                    onChange={(e) => setPasswordCurrent(e.target.value)}
                    disabled={securityBusy === "password:change"}
                  />
                </label>
                <label>
                  <span>{LABELS.newPassword}</span>
                  <input
                    value={passwordNew}
                    aria-label={t("workspaceSettingsDialog:ariaNewPassword")}
                    type="password"
                    autoComplete="new-password"
                    onChange={(e) => setPasswordNew(e.target.value)}
                    disabled={securityBusy === "password:change"}
                  />
                </label>
                <label>
                  <span>{LABELS.confirmNewPassword}</span>
                  <input
                    value={passwordConfirm}
                    aria-label={t("workspaceSettingsDialog:ariaConfirmNewPassword")}
                    type="password"
                    autoComplete="new-password"
                    onChange={(e) => setPasswordConfirm(e.target.value)}
                    disabled={securityBusy === "password:change"}
                  />
                </label>
                <button
                  type="submit"
                  className={styles.primaryButton}
                  disabled={securityBusy === "password:change"}
                >
                  {LABELS.changePasswordButton}
                </button>
              </form>
            </div>

            <LocalLockSecurityPanel />

            <div className={styles.securityPanel}>
              <div className={styles.securityRow}>
                <div>
                  <strong>{LABELS.mfaTitle}</strong>
                  <span>
                    {mfaEnabled
                      ? LABELS.mfaEnabledDesc
                      : LABELS.mfaDisabledDesc}
                  </span>
                </div>
                {mfaEnabled ? (
                  <form className={styles.securityInlineForm} onSubmit={disableTotp}>
                    <input
                      value={mfaDisableCode}
                      aria-label={t("workspaceSettingsDialog:ariaAuthCodeOrPassword")}
                      placeholder={LABELS.codeOrPasswordPlaceholder}
                      autoComplete="current-password"
                      onChange={(e) => setMfaDisableCode(e.target.value)}
                      disabled={securityBusy === "mfa:disable"}
                    />
                    <button
                      type="submit"
                      className={styles.secondaryButton}
                      disabled={securityBusy === "mfa:disable"}
                    >
                      {LABELS.mfaTurnOff}
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => void startTotpEnrollment()}
                    disabled={securityBusy === "mfa:enroll" || !!mfaEnrollment}
                  >
                    {mfaEnrollment ? LABELS.setupInProgress : LABELS.mfaTurnOn}
                  </button>
                )}
              </div>

              {mfaEnrollment ? (
                <form className={styles.securitySetup} onSubmit={verifyTotpSetup} aria-label={LABELS.mfaSetupAriaLabel}>
                  <div className={styles.securitySetupHeader}>
                    <div className={styles.securityInstruction}>
                      <strong>{LABELS.mfaTurnOn}</strong>
                      <span>{LABELS.mfaSetupIntro}</span>
                    </div>
                  </div>

                  <div className={styles.totpStep}>
                    <span className={styles.totpStepMarker}>1</span>
                    <div className={styles.totpStepBody}>
                      <strong>{LABELS.scanQrTitle}</strong>
                      <span>{LABELS.scanQrDesc}</span>
                      <div className={styles.totpSetupGrid}>
                        <div className={styles.totpQrCard}>
                          {mfaQrCodeDataUrl ? (
                            <img
                              src={mfaQrCodeDataUrl}
                              alt={LABELS.qrAlt}
                            />
                          ) : (
                            <span>{mfaQrCodeError || LABELS.qrCreating}</span>
                          )}
                        </div>
                        <div className={styles.totpFallback}>
                          <details className={styles.securityDetails}>
                            <summary>{LABELS.qrFallbackSummary}</summary>
                            <div className={styles.securitySecretRow}>
                              <label className={styles.securitySecret}>
                                <span>{LABELS.manualKeyLabel}</span>
                                <input readOnly value={mfaEnrollment.secret} aria-label={t("workspaceSettingsDialog:ariaAuthSecret")} />
                              </label>
                              <button
                                type="button"
                                className={styles.secondaryButton}
                                onClick={() => void copySecurityText(mfaEnrollment.secret, LABELS.authKeyCopied)}
                              >
                                {LABELS.copyKey}
                              </button>
                            </div>
                            <details className={styles.securityDetails}>
                              <summary>{LABELS.advancedUriSummary}</summary>
                              <div className={styles.securitySecretRow}>
                                <label className={styles.securitySecret}>
                                  <span>{LABELS.setupUriLabel}</span>
                                  <input readOnly value={mfaEnrollment.qrCodeUri} aria-label={t("workspaceSettingsDialog:ariaAuthSetupUri")} />
                                </label>
                                <button
                                  type="button"
                                  className={styles.secondaryButton}
                                  onClick={() => void copySecurityText(mfaEnrollment.qrCodeUri, LABELS.setupUriCopied)}
                                >
                                  {LABELS.copyUri}
                                </button>
                              </div>
                            </details>
                          </details>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className={styles.totpStep}>
                    <span className={styles.totpStepMarker}>2</span>
                    <div className={styles.totpStepBody}>
                      <strong>{LABELS.enterCodeTitle}</strong>
                      <span>{LABELS.enterCodeDesc}</span>
                      <div className={styles.totpApplyFields}>
                        <input
                          value={mfaSetupCode}
                          aria-label={t("workspaceSettingsDialog:ariaSetupVerificationCode")}
                          placeholder="123456"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          onChange={(e) => setMfaSetupCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          disabled={securityBusy === "mfa:verify"}
                        />
                        <div className={styles.totpActionRow}>
                          <button
                            type="submit"
                            className={styles.primaryButton}
                            disabled={securityBusy === "mfa:verify"}
                          >
                            {LABELS.applyVerification}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </form>
              ) : null}

              {mfaRecoveryCodes.length ? (
                <div className={styles.recoveryCodes}>
                  <div className={styles.recoveryHeader}>
                    <div>
                      <strong>{LABELS.recoveryCodesTitle}</strong>
                      <span>{LABELS.recoveryCodesDesc}</span>
                    </div>
                    <span className={styles.recoveryActions}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => void copySecurityText(mfaRecoveryCodes.join("\n"), LABELS.recoveryCodesCopied)}
                      >
                        {LABELS.copyCodes}
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={downloadRecoveryCodes}
                      >
                        {LABELS.saveAsText}
                      </button>
                    </span>
                  </div>
                  <code>{mfaRecoveryCodes.join("\n")}</code>
                  <span>{LABELS.recoveryCodesKeepSafe}</span>
                </div>
              ) : null}

              {mfaEnabled ? (
                <form className={styles.securitySetup} onSubmit={regenerateRecoveryCodes}>
                  <div className={styles.securityInstruction}>
                    <strong>{LABELS.manageRecoveryTitle}</strong>
                    <span>{LABELS.manageRecoveryDesc}</span>
                  </div>
                  <div className={styles.securityInlineForm}>
                    <input
                      value={mfaRecoveryConfirm}
                      aria-label={t("workspaceSettingsDialog:ariaRecoveryRegenConfirm")}
                      placeholder={LABELS.codeOrPasswordPlaceholder}
                      autoComplete="current-password"
                      onChange={(e) => setMfaRecoveryConfirm(e.target.value)}
                      disabled={securityBusy === "mfa:recovery-codes"}
                    />
                    <button
                      type="submit"
                      className={styles.secondaryButton}
                      disabled={securityBusy === "mfa:recovery-codes"}
                    >
                      {LABELS.regenerateCodes}
                    </button>
                  </div>
                </form>
              ) : null}
            </div>

            <div className={styles.securityPanel}>
              <div className={styles.securityRow}>
                <div className={styles.securityInstruction}>
                  <strong>{LABELS.activeSessionsTitle}</strong>
                  <span>{LABELS.activeSessionsDesc}</span>
                </div>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void revokeOtherSessions()}
                  disabled={securityBusy === "sessions:others" || !otherAuthSessions.length}
                >
                  {LABELS.revokeOtherSessions}
                </button>
              </div>
              {authSessions.length ? (
                <div className={styles.securitySessionList}>
                  {authSessions.map((session) => (
                    <div className={styles.securityRow} key={session.id}>
                      <div>
                        <strong>{formatStorageDate(session.createdAt)}</strong>
                        <span>
                          {[
                            session.current ? LABELS.currentSession : "",
                            session.userAgent || LABELS.unknownDevice,
                            session.ip,
                          ].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                      {session.current ? (
                        <span className={styles.securityBadge}>{LABELS.current}</span>
                      ) : (
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() => void revokeSession(session)}
                          disabled={securityBusy === `session:${session.id}` || securityBusy === "sessions:others"}
                        >
                          {LABELS.revoke}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyState}>
                  {securityLoading ? LABELS.loadingSessions : LABELS.noActiveSessions}
                </div>
              )}
            </div>
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "mcp" ? (
          <section id="mcp" className={styles.section} aria-labelledby={mcpSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={mcpSectionId} className={styles.sectionTitle}>
                  {LABELS.navAiConnections}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.mcpMeta}
                </div>
              </div>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => void refreshMcpConnections()}
                disabled={mcpLoading}
              >
                {LABELS.refresh}
              </button>
            </div>

            {mcpError ? <div className={styles.errorText}>{mcpError}</div> : null}
            {mcpNotice ? <div className={styles.noticeText}>{mcpNotice}</div> : null}

            <div className={styles.securityPanel}>
              <div className={styles.securityRow}>
                <div className={styles.securityInstruction}>
                  <strong>{LABELS.mcpServerUrlTitle}</strong>
                  <span>{LABELS.mcpServerUrlDesc}</span>
                </div>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void copyMcpText(mcpConnections?.mcpServerUrl ?? "", LABELS.mcpUrlCopied)}
                  disabled={!mcpConnections?.mcpServerUrl}
                >
                  {LABELS.copyUrl}
                </button>
              </div>
              <code className={styles.securityCode}>
                {mcpConnections?.mcpServerUrl ?? (mcpLoading ? LABELS.loadingEllipsis : LABELS.mcpUrlUnavailable)}
              </code>
              <div className={styles.securityInstruction}>
                <span>
                  {LABELS.mcpScopeNote}
                </span>
              </div>
            </div>

            {mcpConnections?.mcpServerUrl ? (
              <div className={styles.securityPanel} data-testid="mcp-client-snippets">
                <div className={styles.securityInstruction}>
                  <strong>{LABELS.mcpSnippetsTitle}</strong>
                  <span>{LABELS.mcpSnippetsDesc}</span>
                </div>
                {[
                  {
                    key: "claude-code",
                    label: LABELS.mcpSnippetClaudeCode,
                    snippet: `claude mcp add --transport http hanji ${mcpConnections.mcpServerUrl}`,
                  },
                  {
                    key: "cursor",
                    label: LABELS.mcpSnippetCursor,
                    snippet: JSON.stringify(
                      { mcpServers: { hanji: { url: mcpConnections.mcpServerUrl } } },
                      null,
                      2,
                    ),
                  },
                  {
                    key: "generic",
                    label: LABELS.mcpSnippetGeneric,
                    snippet: JSON.stringify(
                      {
                        mcpServers: {
                          hanji: {
                            command: "npx",
                            args: ["-y", "mcp-remote", mcpConnections.mcpServerUrl],
                          },
                        },
                      },
                      null,
                      2,
                    ),
                  },
                ].map((item) => (
                  <div className={styles.securityRow} key={item.key}>
                    <div className={styles.securityInstruction}>
                      <strong>{item.label}</strong>
                      <code className={styles.securityCode}>{item.snippet}</code>
                    </div>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => void copyMcpText(item.snippet, LABELS.mcpSnippetCopied)}
                    >
                      {LABELS.copySnippet}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className={styles.securityPanel}>
              <div className={styles.securityRow}>
                <div className={styles.securityInstruction}>
                  <strong>{LABELS.connectedAiTitle}</strong>
                  <span>
                    {mcpConnections?.grants.length
                      ? LABELS.grantsCount(mcpConnections.grants.length)
                      : mcpLoading
                        ? LABELS.loadingConnectionList
                        : LABELS.noAiApps}
                  </span>
                </div>
              </div>
              {mcpConnections?.grants.length ? (
                <div className={styles.securitySessionList}>
                  {mcpConnections.grants.map((grant) => (
                    <div className={styles.securityRow} key={grant.id}>
                      <div className={styles.securityInstruction}>
                        <strong>{grant.clientName || grant.clientId}</strong>
                        <span>
                          {[
                            grant.status === "revoked" ? LABELS.revokedBadge : LABELS.statusActive,
                            grant.workspaceAccess === "all_accessible" ? LABELS.allAccessible : LABELS.selectedScope,
                            grant.readOnly ? LABELS.readOnly : LABELS.readWrite,
                            grant.lastUsedAt ? LABELS.lastUsedAt(formatStorageDate(grant.lastUsedAt)) : "",
                          ].filter(Boolean).join(" · ")}
                        </span>
                        <span>{grant.scopes.join(", ")}</span>
                      </div>
                      {grant.status === "revoked" ? (
                        <span className={styles.securityBadge}>{LABELS.revokedBadge}</span>
                      ) : (
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() => void revokeMcpGrant(grant.id)}
                          disabled={mcpBusy === `revoke:${grant.id}`}
                        >
                          {LABELS.disconnect}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyState}>
                  {mcpLoading ? LABELS.loadingConnections : LABELS.mcpEmptyHint}
                </div>
              )}
            </div>

            <div className={styles.securityPanel}>
              <div className={styles.securityRow}>
                <div className={styles.securityInstruction}>
                  <strong>{LABELS.manualTokensTitle}</strong>
                  <span>{LABELS.manualTokensDesc}</span>
                </div>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void createManualMcpToken()}
                  disabled={mcpBusy === "manual-token"}
                >
                  {LABELS.createToken}
                </button>
              </div>
              {mcpCreatedToken ? (
                <div className={styles.recoveryCodes}>
                  <div className={styles.recoveryHeader}>
                    <div>
                      <strong>{LABELS.newManualTokenTitle}</strong>
                      <span>{LABELS.newManualTokenDesc}</span>
                    </div>
                    <span className={styles.recoveryActions}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => void copyMcpText(mcpCreatedToken.accessToken, LABELS.accessTokenCopied)}
                      >
                        {LABELS.copyAccess}
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => void copyMcpText(mcpCreatedToken.refreshToken, LABELS.refreshTokenCopied)}
                      >
                        {LABELS.copyRefresh}
                      </button>
                    </span>
                  </div>
                  <span>{t("workspaceSettingsDialog:accessTokenLabel")}</span>
                  <code>{mcpCreatedToken.accessToken}</code>
                  <span>{t("workspaceSettingsDialog:refreshTokenLabel")}</span>
                  <code>{mcpCreatedToken.refreshToken}</code>
                </div>
              ) : null}
            </div>
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "people" ? (
          <section id="people" className={styles.section} aria-labelledby={membersSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={membersSectionId} className={styles.sectionTitle}>
                  {LABELS.navWorkspaceMembers}
                </div>
                <div className={styles.organizationMeta}>{memberDirectorySummary}</div>
              </div>
              {canManageWorkspace ? (
                <div className={styles.sectionActions}>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    aria-expanded={invitePanelOpen}
                    onClick={() => setInvitePanelOpen((current) => !current)}
                  >
                    {LABELS.addMembers}
                  </button>
                </div>
              ) : null}
            </div>

            {memberError ? <div className={styles.notice}>{memberError}</div> : null}

            <div className={styles.memberDirectoryTools}>
              <label className={styles.memberSearch}>
                <Search size={15} aria-hidden="true" />
                <input
                  value={memberQuery}
                  aria-label={t("workspaceSettingsDialog:ariaSearchMembers")}
                  placeholder={LABELS.searchPeoplePlaceholder}
                  autoComplete="off"
                  onChange={(e) => setMemberQuery(e.target.value)}
                />
              </label>
              <span className={styles.memberDirectoryCount}>{memberDirectorySummary}</span>
            </div>

            <div className={styles.memberList} aria-busy={membersLoading || !!memberBusy}>
              {filteredMembers.map((member) => {
                const isOwnerMember = workspace.ownerId === member.userId || member.role === "owner";
                const label = memberDisplayName(member, userId);
                const roleLabel = workspaceRoleLabel(member.role, isOwnerMember);
                const canEditMember =
                  canManageWorkspace &&
                  !isOwnerMember &&
                  member.userId !== userId &&
                  !(currentMember?.role === "admin" && !isWorkspaceOwner && member.role === "admin");
                const canTransferWorkspaceOwner =
                  isWorkspaceOwner && !isOwnerMember && member.userId !== userId;
                const roleOptions =
                  isWorkspaceOwner
                    ? MEMBER_ROLE_OPTIONS
                    : MEMBER_ROLE_OPTIONS.filter((option) => option.value !== "admin");

                return (
                  <div key={member.id} className={styles.memberRow}>
                    <span className={styles.memberAvatar} aria-hidden="true">
                      {label.trim().slice(0, 1).toUpperCase() || memberInitial}
                    </span>
                    <span className={styles.memberText}>
                      <strong>{label}</strong>
                      <span>{memberSubtitle(member, userId)}</span>
                    </span>
                    <span className={styles.memberControls}>
                      {canEditMember ? (
                        <select
                          className={styles.memberSelect}
                          value={workspaceRoleValue(member.role)}
                          aria-label={t("workspaceSettingsDialog:ariaRoleFor", { label })}
                          disabled={memberBusy === `role:${member.id}`}
                          onChange={(e) =>
                            void updateMemberRole(member, e.target.value as WorkspaceMember["role"])
                          }
                        >
                          {roleOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={styles.memberRole}>{roleLabel}</span>
                      )}
                      {canTransferWorkspaceOwner ? (
                        <button
                          type="button"
                          className={styles.memberAction}
                          disabled={memberBusy === `owner:${member.id}`}
                          onClick={() => void transferWorkspaceOwner(member)}
                        >
                          {LABELS.makeOwner}
                        </button>
                      ) : null}
                      {canEditMember ? (
                        <button
                          type="button"
                          className={styles.memberAction}
                          disabled={memberBusy === `remove:${member.id}`}
                          onClick={() => void removeMember(member)}
                        >
                          {LABELS.remove}
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })}

              {membersLoading && renderedMembers.length === 0 ? (
                <div className={styles.emptyState}>{LABELS.loadingMembers}</div>
              ) : null}
            </div>

            {!membersLoading && filteredMembers.length === 0 ? (
              <div className={styles.emptyState}>
                {normalizedMemberQuery ? LABELS.noSearchResults : LABELS.noMembers}
              </div>
            ) : null}

            {canManageWorkspace && invitePanelOpen ? (
              <form className={styles.memberInvite} onSubmit={addMember}>
                <div className={styles.memberAddField}>
                  <input
                    value={memberAddQuery}
                    placeholder={canSearchServerUsers ? LABELS.searchPeoplePlaceholder : LABELS.emailPlaceholder}
                    aria-label={t("workspaceSettingsDialog:ariaMemberEmail")}
                    type={canSearchServerUsers ? "text" : "email"}
                    autoComplete="off"
                    onChange={(e) => {
                      setMemberAddQuery(e.target.value);
                      setSelectedServerUser(null);
                    }}
                  />
                  {canSearchServerUsers && serverUserResults.length > 0 ? (
                    <ul className={styles.memberAddResults}>
                      {serverUserResults.map((user) => (
                        <li key={user.id}>
                          <button
                            type="button"
                            className={styles.memberAddResult}
                            data-selected={selectedServerUser?.id === user.id ? "true" : undefined}
                            onClick={() => {
                              setSelectedServerUser(user);
                              setMemberAddQuery(user.email ?? user.displayName ?? "");
                            }}
                          >
                            <strong>{user.displayName || user.email || user.id}</strong>
                            {user.email ? <span>{user.email}</span> : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <select
                  value={inviteRole}
                  aria-label={t("workspaceSettingsDialog:ariaNewMemberRole")}
                  onChange={(e) => setInviteRole(e.target.value as WorkspaceMember["role"])}
                >
                  {(isWorkspaceOwner
                    ? MEMBER_ROLE_OPTIONS
                    : MEMBER_ROLE_OPTIONS.filter((option) => option.value !== "admin")
                  ).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className={styles.primaryButton}
                  disabled={memberBusy === "addMember"}
                >
                  {LABELS.addMembers}
                </button>
              </form>
            ) : null}

            {canManageWorkspace && workspace?.id ? (
              <ImportedPeopleMapping workspaceId={workspace.id} />
            ) : null}

            {!canManageWorkspace ? (
              <div className={styles.notice} data-tone="neutral">
                {LABELS.adminRequired}
              </div>
            ) : null}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "workspace-security" ? (
          <section id="workspace-security" className={styles.section} aria-labelledby={workspaceSecuritySectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={workspaceSecuritySectionId} className={styles.sectionTitle}>
                  {LABELS.workspaceSecurityTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {LABELS.workspaceSecurityMeta}
                </div>
              </div>
              {organization?.id ? (
                <div className={styles.sectionActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void refreshOrganizationDirectory()}
                    disabled={organizationLoading || !!organizationBusy}
                  >
                    {LABELS.refresh}
                  </button>
                </div>
              ) : null}
            </div>

            {organizationError ? <div className={styles.notice}>{organizationError}</div> : null}

            {!organization?.id ? (
              <div className={styles.notice} data-tone="neutral">
                {LABELS.noOrganizationYet}
              </div>
            ) : null}

            <div className={styles.organizationPolicyBlock}>
              <div className={styles.organizationSubhead}>
                <span>{LABELS.sharingPoliciesTitle}</span>
                <strong>
                  {SHARING_POLICY_OPTIONS.filter((option) => organizationSharingPolicyAllows(organization, option.key)).length}
                </strong>
              </div>
              <div className={styles.sharingPolicyGrid}>
                {SHARING_POLICY_OPTIONS.map((option) => {
                  const active = organizationSharingPolicyAllows(organization, option.key);
                  return (
                    <button
                      key={option.key}
                      type="button"
                      className={styles.sharingPolicyToggle}
                      aria-pressed={active}
                      disabled={!canManageOrganizationSecurity || organizationBusy === `policy:sharing:${option.key}`}
                      onClick={() => void updateSharingPolicy(option.key, !active)}
                    >
                      <span>{option.label}</span>
                      <span className={styles.policySwitch} data-on={active ? "true" : undefined} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>

            {!canManageOrganizationSecurity ? (
              <div className={styles.notice} data-tone="neutral">
                {LABELS.orgSecurityAdminRequired}
              </div>
            ) : null}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "organization" ? (
          <section id="organization" className={styles.section} aria-labelledby={organizationSectionId}>
            <div className={styles.sectionHeader}>
              <div>
                <div id={organizationSectionId} className={styles.sectionTitle}>
                  {LABELS.organizationAdminTitle}
                </div>
                <div className={styles.organizationMeta}>
                  {organization?.name ?? LABELS.organizationFallback} · {organizationAccountLabel}
                </div>
              </div>
              {organization?.id ? (
                <div className={styles.sectionActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void refreshOrganizationDirectory()}
                    disabled={organizationLoading || !!organizationBusy}
                  >
                    {LABELS.refresh}
                  </button>
                </div>
              ) : null}
            </div>

            {organizationError ? <div className={styles.notice}>{organizationError}</div> : null}

            {!organization?.id ? (
              <div className={styles.notice} data-tone="neutral">
                {LABELS.noOrganizationYet}
              </div>
            ) : null}

            <div className={styles.organizationPolicyBlock}>
              <div className={styles.organizationSubhead}>
                <span>{LABELS.workspaceCreationTitle}</span>
                <strong>{workspaceCreationPolicyLabel(organization?.workspaceCreationPolicy)}</strong>
              </div>
              {canManageOrganizationPeople ? (
                <div className={styles.policyOptions} role="radiogroup" aria-label={t("workspaceSettingsDialog:ariaWorkspaceCreationPolicy")}>
                  {WORKSPACE_CREATION_POLICY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={styles.policyOption}
                      role="radio"
                      aria-checked={workspaceCreationPolicy === option.value}
                      data-active={workspaceCreationPolicy === option.value ? "true" : undefined}
                      disabled={organizationBusy === "policy:workspaceCreation"}
                      onClick={() => void updateWorkspaceCreationPolicy(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className={styles.organizationPolicyBlock}>
              <div className={styles.organizationSubhead}>
                <span>{LABELS.domainSignupTitle}</span>
                <strong>{domainSignupPolicyLabel(organization?.domainSignupPolicy)}</strong>
              </div>
              {canManageOrganizationSecurity ? (
                <div className={styles.policyOptions} role="radiogroup" aria-label={t("workspaceSettingsDialog:ariaDomainSignupPolicy")}>
                  {DOMAIN_SIGNUP_POLICY_OPTIONS.map((option) => {
                    const disabled =
                      organizationBusy === "policy:domainSignup" ||
                      (option.value === "verified_domains" && verifiedOrganizationDomainCount === 0);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={styles.policyOption}
                        role="radio"
                        aria-checked={domainSignupPolicy === option.value}
                        data-active={domainSignupPolicy === option.value ? "true" : undefined}
                        disabled={disabled}
                        onClick={() => void updateDomainSignupPolicy(option.value)}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <div className={styles.fieldMessage}>{organizationDomainPolicyLabel}</div>
            </div>

            <div className={styles.organizationDomainBlock}>
              <div className={styles.organizationSubhead}>
                <span>{LABELS.groupsTitle}</span>
                <strong>{organizationGroups.length}</strong>
              </div>

              {organizationGroups.length ? (
                <div className={styles.domainList}>
                  {organizationGroups.map((group) => {
                    const availableMembers = activeOrganizationMembers.filter(
                      (member) =>
                        !group.members.some(
                          (groupMember) => groupMember.organizationMemberId === member.id,
                        ),
                    );
                    const selectedMemberId = organizationGroupMemberDrafts[group.id] ?? "";
                    const groupNameDraft = organizationGroupEditDrafts[group.id] ?? group.name;
                    const canSaveGroupName =
                      canManageOrganizationPeople &&
                      groupNameDraft.trim().length > 0 &&
                      groupNameDraft.trim() !== group.name;
                    return (
                      <div key={group.id} className={styles.domainRow}>
                        <div className={styles.domainText}>
                          <form
                            className={styles.groupNameForm}
                            onSubmit={(event) => void updateOrganizationGroup(group, event)}
                          >
                            <input
                              value={groupNameDraft}
                              aria-label={t("workspaceSettingsDialog:ariaGroupNameFor", { name: group.name })}
                              disabled={
                                !canManageOrganizationPeople ||
                                organizationBusy === `group:update:${group.id}`
                              }
                              onChange={(event) =>
                                setOrganizationGroupEditDrafts((drafts) => ({
                                  ...drafts,
                                  [group.id]: event.target.value,
                                }))
                              }
                            />
                            {canSaveGroupName ? (
                              <button
                                type="submit"
                                className={styles.memberAction}
                                disabled={organizationBusy === `group:update:${group.id}`}
                              >
                                {LABELS.save}
                              </button>
                            ) : null}
                          </form>
                          <span>{LABELS.peopleCount(group.members.length)}</span>
                          {group.members.length ? (
                            <span>
                              {group.members
                                .slice(0, 3)
                                .map((member) => member.displayName || member.email || member.userId)
                                .join(", ")}
                            </span>
                          ) : null}
                        </div>
                        <span className={styles.memberControls}>
                          {canManageOrganizationPeople && availableMembers.length ? (
                            <select
                              className={styles.memberSelect}
                              aria-label={t("workspaceSettingsDialog:ariaAddMemberToGroup", { name: group.name })}
                              value={selectedMemberId}
                              disabled={organizationBusy === `group:add:${group.id}`}
                              onChange={(event) =>
                                setOrganizationGroupMemberDrafts((drafts) => ({
                                  ...drafts,
                                  [group.id]: event.target.value,
                                }))
                              }
                            >
                              <option value="">{LABELS.addPerson}</option>
                              {availableMembers.map((member) => (
                                <option key={member.id} value={member.id}>
                                  {organizationMemberDisplayName(member, userId)}
                                </option>
                              ))}
                            </select>
                          ) : null}
                          {canManageOrganizationPeople && selectedMemberId ? (
                            <button
                              type="button"
                              className={styles.memberAction}
                              disabled={organizationBusy === `group:add:${group.id}`}
                              onClick={() => void addOrganizationGroupMember(group)}
                            >
                              {LABELS.add}
                            </button>
                          ) : null}
                          {group.members.slice(0, 3).map((member) => (
                            <button
                              key={member.id}
                              type="button"
                              className={styles.memberAction}
                              disabled={
                                !canManageOrganizationPeople ||
                                organizationBusy === `group:remove:${member.id}`
                              }
                              onClick={() => void removeOrganizationGroupMember(group, member)}
                            >
                              {LABELS.removeNamed(member.displayName || member.email || LABELS.member)}
                            </button>
                          ))}
                          {canManageOrganizationPeople ? (
                            <button
                              type="button"
                              className={styles.memberAction}
                              disabled={organizationBusy === `group:delete:${group.id}`}
                              onClick={() => void deleteOrganizationGroup(group)}
                            >
                              {LABELS.delete}
                            </button>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.emptyState}>{LABELS.noGroups}</div>
              )}

              {canManageOrganizationPeople ? (
                <form className={styles.organizationDomainForm} onSubmit={createOrganizationGroup}>
                  <input
                    value={organizationGroupDraft}
                    aria-label={t("workspaceSettingsDialog:ariaOrgGroupName")}
                    placeholder={t("workspaceSettingsDialog:placeholderGroupExamples")}
                    autoComplete="off"
                    disabled={organizationBusy === "group:create"}
                    onChange={(e) => setOrganizationGroupDraft(e.target.value)}
                  />
                  <button
                    type="submit"
                    className={styles.primaryButton}
                    disabled={organizationBusy === "group:create"}
                  >
                    {LABELS.addGroup}
                  </button>
                </form>
              ) : null}
            </div>

            <div className={styles.organizationDomainBlock}>
              <div className={styles.organizationSubhead}>
                <span>{LABELS.domainsTitle}</span>
                <strong>{organizationDomains.length}</strong>
              </div>

              {organizationDomains.length ? (
                <div className={styles.domainList}>
                  {organizationDomains.map((domain) => {
                    const statusLabel = organizationDomainStatus(domain);
                    const verified = statusLabel === LABELS.statusVerified;
                    return (
                      <div key={domain.id} className={styles.domainRow}>
                        <span className={styles.domainText}>
                          <strong>{domain.domain}</strong>
                          <span>{verified && domain.verifiedAt ? LABELS.verifiedAt(formatStorageDate(domain.verifiedAt)) : statusLabel}</span>
                        </span>
                        <span className={styles.domainControls}>
                          <span
                            className={styles.memberStatus}
                            data-status={verified ? "active" : "deactivated"}
                          >
                            {statusLabel}
                          </span>
                          {canManageOrganizationSecurity && !verified ? (
                            <button
                              type="button"
                              className={styles.memberAction}
                              disabled={organizationBusy === `domain:verify:${domain.id}`}
                              onClick={() => void verifyOrganizationDomain(domain)}
                            >
                              {LABELS.verify}
                            </button>
                          ) : null}
                          {canManageOrganizationSecurity ? (
                            <button
                              type="button"
                              className={styles.memberAction}
                              disabled={organizationBusy === `domain:remove:${domain.id}`}
                              onClick={() => void removeOrganizationDomain(domain)}
                            >
                              {LABELS.remove}
                            </button>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.emptyState}>{LABELS.noDomains}</div>
              )}

              {canManageOrganizationSecurity ? (
                <form className={styles.organizationDomainForm} onSubmit={addOrganizationDomain}>
                  <input
                    value={organizationDomainDraft}
                    aria-label={t("workspaceSettingsDialog:ariaOrgDomain")}
                    placeholder="example.com"
                    autoComplete="off"
                    disabled={organizationBusy === "domain:add"}
                    onChange={(e) => setOrganizationDomainDraft(e.target.value)}
                  />
                  <button
                    type="submit"
                    className={styles.primaryButton}
                    disabled={organizationBusy === "domain:add"}
                  >
                    {LABELS.addDomain}
                  </button>
                </form>
              ) : null}
            </div>

            <div className={styles.memberDirectoryTools}>
              <label className={styles.memberSearch}>
                <Search size={15} aria-hidden="true" />
                <input
                  value={organizationQuery}
                  aria-label={t("workspaceSettingsDialog:ariaSearchOrgMembers")}
                  placeholder={LABELS.searchPeoplePlaceholder}
                  autoComplete="off"
                  onChange={(e) => setOrganizationQuery(e.target.value)}
                />
              </label>
              <span className={styles.memberDirectoryCount}>{organizationDirectorySummary}</span>
            </div>

            <div className={styles.memberList} aria-busy={organizationLoading || !!organizationBusy}>
              {filteredOrganizationMembers.map((member) => {
                const label = organizationMemberDisplayName(member, userId);
                const profile = profileForOrganizationMember(member);
                const profileSummary = organizationProfileSummary(profile);
                const isOwnerMember = organization?.ownerId === member.userId || member.role === "owner";
                const targetOrganizationRole = isOwnerMember ? "owner" : organizationRoleValue(member.role);
                const targetIsAdminRole =
                  targetOrganizationRole === "admin" ||
                  targetOrganizationRole === "security_admin" ||
                  targetOrganizationRole === "billing_admin";
                const statusLabel = organizationMemberStatus(member);
                const deactivated = statusLabel === LABELS.statusDeactivated;
                const canEditOrganizationMember =
                  canManageOrganizationPeople &&
                  !isOwnerMember &&
                  member.userId !== userId &&
                  (isOrganizationOwner || !targetIsAdminRole);
                const canEditOrganizationRole =
                  isOrganizationOwner && !isOwnerMember && !deactivated && member.userId !== userId;
                const canTransferOrganizationOwner =
                  isOrganizationOwner && !isOwnerMember && !deactivated && member.userId !== userId;
                const busyKey = `${deactivated ? "reactivate" : "deactivate"}:${member.id}`;
                const reassignmentCandidates = organizationReassignmentCandidatesFor(member);
                const reassignmentMemberId = selectedOrganizationReassignmentMemberId(member);

                return (
                  <div
                    key={member.id}
                    className={styles.memberRow}
                    data-muted={deactivated ? "true" : undefined}
                  >
                    <span className={styles.memberAvatar} aria-hidden="true">
                      {label.trim().slice(0, 1).toUpperCase() || memberInitial}
                    </span>
                    <span className={styles.memberText}>
                      <strong>{label}</strong>
                      <span>
                        {[organizationMemberSubtitle(member, userId), profileSummary].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className={styles.memberControls}>
                      <span
                        className={styles.memberStatus}
                        data-status={deactivated ? "deactivated" : "active"}
                      >
                        {statusLabel}
                      </span>
                      {canEditOrganizationRole ? (
                        <select
                          className={styles.memberSelect}
                          value={organizationRoleValue(member.role)}
                          aria-label={t("workspaceSettingsDialog:ariaOrgRoleFor", { label })}
                          disabled={organizationBusy === `org-role:${member.id}`}
                          onChange={(event) =>
                            void updateOrganizationRole(
                              member,
                              event.target.value as Exclude<OrganizationMemberRole, "owner">,
                            )
                          }
                        >
                          {ORGANIZATION_ROLE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={styles.memberRole}>
                          {organizationRoleLabel(member.role, isOwnerMember)}
                        </span>
                      )}
                      {canTransferOrganizationOwner ? (
                        <button
                          type="button"
                          className={styles.memberAction}
                          disabled={organizationBusy === `owner:${member.id}`}
                          onClick={() => void transferOrganizationOwner(member)}
                        >
                          {LABELS.makeOwner}
                        </button>
                      ) : null}
                      {canEditOrganizationMember ? (
                        <button
                          type="button"
                          className={styles.memberAction}
                          disabled={organizationBusy === busyKey}
                          onClick={() => void updateOrganizationMemberStatus(member)}
                        >
                          {deactivated ? LABELS.reactivate : LABELS.deactivate}
                        </button>
                      ) : null}
                      {canEditOrganizationMember ? (
                        <select
                          className={`${styles.memberSelect} ${styles.reassignmentSelect}`}
                          aria-label={t("workspaceSettingsDialog:ariaReassignContent", { label })}
                          value={reassignmentMemberId}
                          disabled={organizationBusy === `remove:${member.id}`}
                          onChange={(event) =>
                            setOrganizationReassignmentDrafts((drafts) => ({
                              ...drafts,
                              [member.id]: event.target.value,
                            }))
                          }
                        >
                          {!reassignmentCandidates.length ? (
                            <option value="">{LABELS.noContentToTransfer}</option>
                          ) : null}
                          {reassignmentCandidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {LABELS.transferContentTo(organizationMemberDisplayName(candidate, userId))}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {canEditOrganizationMember ? (
                        <button
                          type="button"
                          className={styles.memberAction}
                          disabled={organizationBusy === `remove:${member.id}` || !reassignmentMemberId}
                          onClick={() => void removeOrganizationMember(member)}
                        >
                          {LABELS.remove}
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })}

              {organizationLoading && organizationDirectoryMembers.length === 0 ? (
                <div className={styles.emptyState}>{LABELS.loadingOrganization}</div>
              ) : null}
            </div>

            {!organizationLoading && filteredOrganizationMembers.length === 0 ? (
              <div className={styles.emptyState}>
                {normalizedOrganizationQuery ? LABELS.noSearchResults : LABELS.noOrgMembers}
              </div>
            ) : null}

            {canManageOrganization ? (
              <div className={styles.auditBlock}>
                <div className={styles.organizationSubhead}>
                  <span>{LABELS.navAuditLog}</span>
                  <strong>{filteredOrganizationAuditEvents.length}</strong>
                </div>
                <div className={styles.auditTools}>
                  <select
                    value={organizationAuditAction}
                    aria-label={t("workspaceSettingsDialog:ariaFilterAudit")}
                    onChange={(event) => setOrganizationAuditAction(event.target.value)}
                  >
                    {AUDIT_ACTION_OPTIONS.map((option) => (
                      <option key={option.value || "all"} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                {filteredOrganizationAuditEvents.length ? (
                  <div className={styles.auditList}>
                    {filteredOrganizationAuditEvents.slice(0, 8).map((event) => (
                      <div key={event.id} className={styles.auditRow}>
                        <span className={styles.auditText}>
                          <strong>{organizationAuditLabel(event)}</strong>
                          <span>{organizationAuditDetail(event)}</span>
                        </span>
                        <time dateTime={event.occurredAt}>{formatStorageDate(event.occurredAt)}</time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.emptyState}>{LABELS.noMatchingAudit}</div>
                )}
              </div>
            ) : null}

            {!canManageOrganization ? (
              <div className={styles.notice} data-tone="neutral">
                {LABELS.orgAdminRequired}
              </div>
            ) : null}
          </section>
          ) : null}

          {renderCurrentSection && visibleSettingsSection === "usage" ? (
          <section id="usage" className={styles.section} aria-labelledby={storageSectionId}>
            <div className={styles.sectionHeader}>
              <div id={storageSectionId} className={styles.sectionTitle}>
                {LABELS.navUsage}
              </div>
              {canViewStorage ? (
                <div className={styles.sectionActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void refreshFileReport()}
                    disabled={fileReportLoading || fileCleanupBusy}
                  >
                    {LABELS.refresh}
                  </button>
                  {canManageStorage ? (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => void cleanupExpiredUploads()}
                      disabled={fileReportLoading || fileCleanupBusy}
                    >
                      {LABELS.cleanUp}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {!canViewStorage ? (
              <div className={styles.notice} data-tone="neutral">
                {LABELS.adminRequired}
              </div>
            ) : fileReportError ? (
              <div className={styles.notice}>{fileReportError}</div>
            ) : null}

            {canManageOrganizationBilling && organizationFileReport ? (
              <div className={styles.storageSubsection}>
                <div className={styles.storageSubtitle}>{LABELS.orgUsageTitle}</div>
                <div className={styles.storageGrid} aria-busy={fileReportLoading || fileCleanupBusy}>
                  <div className={styles.metricTile}>
                    <span>{LABELS.activeStorageTile}</span>
                    <strong>{formatBytes(organizationFileTotals?.activeStorageBytes)}</strong>
                  </div>
                  <div className={styles.metricTile}>
                    <span>{LABELS.filesTile}</span>
                    <strong>{organizationFileTotals?.files ?? 0}</strong>
                  </div>
                  <div className={styles.metricTile}>
                    <span>{LABELS.workspacesTile}</span>
                    <strong>{organizationFileReport.workspaceCount ?? topWorkspaces.length}</strong>
                  </div>
                  <div
                    className={styles.metricTile}
                    data-attention={
                      organizationStorageLimit &&
                      (organizationFileTotals?.activeStorageBytes ?? 0) > organizationStorageLimit
                        ? "true"
                        : undefined
                    }
                  >
                    <span>{LABELS.limitTile}</span>
                    <strong>
                      {organizationStorageLimit ? formatBytes(organizationStorageLimit) : LABELS.noLimit}
                    </strong>
                  </div>
                </div>

                {canManageOrganizationBilling ? (
                  <form className={styles.storageLimitForm} onSubmit={saveOrganizationStorageLimit}>
                    <label>
                      <span>{LABELS.storageLimitField}</span>
                      <input
                        value={storageLimitDraft}
                        aria-label={t("workspaceSettingsDialog:ariaOrgStorageLimit")}
                        inputMode="decimal"
                        placeholder={LABELS.noLimit}
                        disabled={organizationBusy === "policy:storageLimit"}
                        onChange={(e) => setStorageLimitDraft(e.target.value)}
                      />
                      <strong>MB</strong>
                    </label>
                    <button
                      type="submit"
                      className={styles.secondaryButton}
                      disabled={organizationBusy === "policy:storageLimit"}
                    >
                      {LABELS.save}
                    </button>
                  </form>
                ) : null}

                {topWorkspaces.length ? (
                  <div className={styles.scopeList}>
                    {topWorkspaces.map((item) => (
                      <div key={item.workspaceId} className={styles.scopeRow}>
                        <span>{item.name || item.domain || LABELS.untitledWorkspace}</span>
                        <strong>
                          {item.totals.files} · {formatBytes(item.totals.activeStorageBytes)}
                        </strong>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {canManageStorage ? (
              <>
                <div className={styles.storageSubtitle}>{LABELS.workspaceUsageTitle}</div>
                <div className={styles.storageGrid} aria-busy={fileReportLoading || fileCleanupBusy}>
                  <div className={styles.metricTile}>
                    <span>{LABELS.activeStorageTile}</span>
                    <strong>{formatBytes(fileTotals?.activeStorageBytes)}</strong>
                  </div>
                  <div className={styles.metricTile}>
                    <span>{LABELS.filesTile}</span>
                    <strong>{fileTotals?.files ?? 0}</strong>
                  </div>
                  <div className={styles.metricTile}>
                    <span>{LABELS.pendingTile}</span>
                    <strong>{pendingActive}</strong>
                  </div>
                  <div className={styles.metricTile} data-attention={pendingExpired > 0 ? "true" : undefined}>
                    <span>{LABELS.expiredTile}</span>
                    <strong>{pendingExpired}</strong>
                  </div>
                </div>

                <div className={styles.storageRows}>
                  <div className={styles.storageRow}>
                    <span>{LABELS.uploadedBytes}</span>
                    <strong>{formatBytes(fileTotals?.uploadedBytes)}</strong>
                  </div>
                  <div className={styles.storageRow}>
                    <span>{LABELS.deletedBytes}</span>
                    <strong>{formatBytes(fileTotals?.deletedBytes)}</strong>
                  </div>
                  <div className={styles.storageRow}>
                    <span>{LABELS.lastCleanup}</span>
                    <strong>{formatStorageDate(latestRun?.startedAt ?? latestRun?.createdAt)}</strong>
                  </div>
                  {latestRun ? (
                    <div className={styles.storageRow}>
                      <span>{LABELS.cleanupResult}</span>
                      <strong>
                        {LABELS.cleanupResultSummary(latestRun.expired ?? 0, latestRun.failedObjects ?? 0)}
                      </strong>
                    </div>
                  ) : null}
                </div>

                {topScopes.length ? (
                  <div className={styles.scopeList}>
                    {topScopes.map(([scope, stat]) => (
                      <div key={scope} className={styles.scopeRow}>
                        <span>{scope}</span>
                        <strong>
                          {stat.count} · {formatBytes(stat.bytes)}
                        </strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.emptyState}>
                    {fileReportLoading ? LABELS.loadingUsage : LABELS.noFilesYet}
                  </div>
                )}
              </>
            ) : null}
          </section>
          ) : null}

        </div>
      </section>
    </div>
  );
}

// 로컬 데이터 잠금 (key custody — docs/local-first-roadmap.md §10). Mode
// changes clear the durable local caches by design (they are caches), so the
// outbox must be drained first; store orchestration enforces that.
function LocalLockSecurityPanel() {
  const { t } = useTranslation(["workspaceSettingsDialog", "common"]);
  const notify = useStore((s) => s.notify);
  const [mode, setMode] = useState<LocalEncryptionMode>(() => localEncryptionMode());
  const [enablePass, setEnablePass] = useState("");
  const [enableConfirm, setEnableConfirm] = useState("");
  const [currentPass, setCurrentPass] = useState("");
  const [nextPass, setNextPass] = useState("");
  const [nextConfirm, setNextConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function fail(result: LocalLockChangeResult): string {
    if (result === "pending-changes") return LABELS.lockPendingChanges;
    if (result === "wrong-passphrase") return LABELS.lockWrongPassphrase;
    return LABELS.lockUnavailable;
  }

  async function onEnable(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (enablePass.length < 8) return setError(LABELS.passphraseTooShort);
    if (enablePass !== enableConfirm) return setError(LABELS.passphraseMismatch);
    setBusy(true);
    setError("");
    const result = await enableLocalPassphraseLock(enablePass);
    setBusy(false);
    if (result !== "ok") return setError(fail(result));
    setMode("passphrase");
    setEnablePass("");
    setEnableConfirm("");
    notify(LABELS.lockEnabledNotice, "default");
  }

  async function onChangePass(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (nextPass.length < 8) return setError(LABELS.newPassphraseTooShort);
    if (nextPass !== nextConfirm) return setError(LABELS.newPassphraseMismatch);
    setBusy(true);
    setError("");
    const result = await changeLocalPassphrase(currentPass, nextPass);
    setBusy(false);
    if (result !== "ok") return setError(fail(result));
    setCurrentPass("");
    setNextPass("");
    setNextConfirm("");
    notify(LABELS.passphraseChangedNotice, "default");
  }

  async function onDisable() {
    if (!currentPass) return setError(LABELS.enterCurrentPassphrase);
    setBusy(true);
    setError("");
    const result = await disableLocalPassphraseLock(currentPass);
    setBusy(false);
    if (result !== "ok") return setError(fail(result));
    setMode("device");
    setCurrentPass("");
    notify(LABELS.lockDisabledNotice, "default");
  }

  return (
    <div className={styles.securityPanel} data-testid="local-lock-panel">
      <div className={styles.securityRow}>
        <div>
          <strong>{LABELS.localLockTitle}</strong>
          <span>
            {mode === "passphrase"
              ? LABELS.localLockOnDesc
              : LABELS.localLockOffDesc}
          </span>
        </div>
      </div>
      <div className={styles.notice} data-testid="local-lock-forget-warning">
        {LABELS.localLockForgetWarning}
      </div>
      {mode === "device" ? (
        <form className={styles.passwordChangeForm} onSubmit={onEnable}>
          <label>
            <span>{LABELS.lockPassphrase}</span>
            <input
              value={enablePass}
              aria-label={t("workspaceSettingsDialog:ariaLocalLockPassphrase")}
              type="password"
              autoComplete="new-password"
              onChange={(e) => setEnablePass(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            <span>{LABELS.confirmPassphrase}</span>
            <input
              value={enableConfirm}
              aria-label={t("workspaceSettingsDialog:ariaConfirmLocalLockPassphrase")}
              type="password"
              autoComplete="new-password"
              onChange={(e) => setEnableConfirm(e.target.value)}
              disabled={busy}
            />
          </label>
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {LABELS.lockOn}
          </button>
        </form>
      ) : (
        <form className={styles.passwordChangeForm} onSubmit={onChangePass}>
          <label>
            <span>{LABELS.currentPassphrase}</span>
            <input
              value={currentPass}
              aria-label={t("workspaceSettingsDialog:ariaCurrentLocalLockPassphrase")}
              type="password"
              autoComplete="current-password"
              onChange={(e) => setCurrentPass(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            <span>{LABELS.newPassphrase}</span>
            <input
              value={nextPass}
              aria-label={t("workspaceSettingsDialog:ariaNewLocalLockPassphrase")}
              type="password"
              autoComplete="new-password"
              onChange={(e) => setNextPass(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            <span>{LABELS.confirmNewPassphrase}</span>
            <input
              value={nextConfirm}
              aria-label={t("workspaceSettingsDialog:ariaConfirmNewLocalLockPassphrase")}
              type="password"
              autoComplete="new-password"
              onChange={(e) => setNextConfirm(e.target.value)}
              disabled={busy}
            />
          </label>
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {LABELS.changePassphrase}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            data-testid="local-lock-disable"
            onClick={() => void onDisable()}
            disabled={busy}
          >
            {LABELS.lockOffWithPass}
          </button>
        </form>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
