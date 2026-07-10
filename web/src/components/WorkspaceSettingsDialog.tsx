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
  inviteWorkspaceMemberRemote,
  listMcpConnectionsRemote,
  listAuthSessionsRemote,
  listMfaFactorsRemote,
  reactivateOrganizationMemberRemote,
  regenerateRecoveryCodesRemote,
  removeOrganizationGroupMemberRemote,
  removeWorkspaceInvitationRemote,
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
  type TotpEnrollment,
} from "@/lib/edgebase";
import { pickLabels } from "@/lib/i18n";
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
  WorkspaceInvitation,
  WorkspaceMember,
} from "@/lib/types";
import { EmojiPicker } from "./EmojiPicker";
import { GlobeIcon, LockIcon, PaletteIcon, Search, SharePeopleIcon, Upload, UserIcon } from "./icons";
import { WorkspaceIconGlyph } from "./PageIcon";
import styles from "./WorkspaceSettingsDialog.module.css";

const WORKSPACE_SETTINGS_LABELS = {
  en: {
    // Common actions
    add: "Add",
    cleanUp: "Clean up",
    copy: "Copy",
    delete: "Delete",
    invite: "Invite",
    refresh: "Refresh",
    remove: "Remove",
    revoke: "Revoke",
    save: "Save",
    verify: "Verify",
    // Common labels
    adminOnlyNotice: "Only organization owners, admins, security admins, and billing admins can use this screen.",
    adminRequired: "Admin access is required.",
    clipboardCopyFailed: "Could not copy to the clipboard.",
    me: "Me",
    member: "Member",
    myAccount: "My account",
    none: "None",
    noSearchResults: "No search results.",
    untitledWorkspace: "Untitled workspace",
    // Roles
    roleAdmin: "Admin",
    roleBillingAdmin: "Billing admin",
    roleGuest: "Guest",
    roleMember: "Member",
    roleOwner: "Owner",
    roleSecurityAdmin: "Security admin",
    // Theme
    themeDark: "Dark",
    themeLight: "Light",
    themeSystem: "System",
    // Policies
    policyMembers: "Members",
    policyOwnersAdmins: "Owners and admins",
    signupInviteOnly: "Invites only",
    signupPublic: "Anyone",
    signupVerifiedDomains: "Verified domains or invites",
    domainSignupVerified: "Verified domains",
    sharingExternalEmail: "External email",
    sharingFileDownloads: "File downloads",
    sharingFullAccess: "Full access",
    sharingGuests: "Guests",
    sharingPublicWeb: "Public web sharing",
    // Audit action filter options
    auditAllEvents: "All events",
    auditLoginAttempt: "Login attempt",
    auditSettingsUpdate: "Settings change",
    auditMemberDeactivate: "Deactivation",
    auditMemberReactivate: "Reactivation",
    auditMemberRoleUpdate: "Organization role change",
    auditMemberRemove: "Member removal",
    auditOwnerTransfer: "Owner transfer",
    auditDomainCreate: "Domain added",
    auditDomainVerify: "Domain verified",
    auditDomainRemove: "Domain removed",
    auditWorkspaceCreate: "Workspace created",
    auditWorkspaceDelete: "Workspace deleted",
    auditWorkspaceOwnerTransfer: "Workspace owner transfer",
    auditInviteEmailSent: "Invitation email sent",
    auditInviteEmailFailed: "Invitation email failed",
    auditInviteEmailNotConfigured: "Invitation email not configured",
    auditWebShare: "Web sharing",
    auditPagePermissionGrant: "Page permission granted",
    auditPagePermissionUpdate: "Page permission changed",
    auditPagePermissionRevoke: "Page permission revoked",
    auditExportPage: "Page export",
    auditExportDatabase: "Database export",
    auditExportWorkspace: "Workspace export",
    auditPageDelete: "Page deleted",
    auditDatabaseRowDelete: "Database row deleted",
    // Statuses
    statusActive: "Active",
    statusDeactivated: "Deactivated",
    statusPending: "Pending",
    statusRejected: "Rejected",
    statusVerified: "Verified",
    instanceAdminBadge: "Instance admin",
    // Server audit helpers
    scopeOrganization: "Organization",
    scopeServer: "Server",
    auditTarget: (target: string) => `Target ${target}`,
    auditWorkspaceRef: (id: string) => `Workspace ${id}`,
    auditActorRef: (id: string) => `Actor ${id}`,
    auditSignupPolicyRef: (policy: string) => `Signup policy ${policy}`,
    auditDisabledRef: (disabled: boolean) => `Disabled ${disabled ? "yes" : "no"}`,
    auditSessionsRevoked: "Sessions revoked",
    // Import job statuses
    jobCancelled: "Cancelled",
    jobCompleted: "Completed",
    jobDiscovering: "Discovering",
    jobFailed: "Failed",
    jobQueued: "Queued",
    jobReady: "Ready to apply",
    jobUnknown: "Unknown",
    // Health statuses
    healthAttention: "Needs attention",
    healthMissing: "Not configured",
    healthOk: "OK",
    // Module helper errors
    codeOrPasswordMismatch: "The code or password is incorrect.",
    recoveryCodeMismatch: "Check your recovery code and try again.",
    storageLimitInvalid: "Storage limit must be 0 or more.",
    totpCodeMismatch: "That authenticator code is incorrect. Check the newest 6-digit code in your app and try again.",
    // Member management errors
    memberAddFailed: "Could not add member.",
    memberEmailInvalid: "Enter a valid email address.",
    memberEmailRequired: "Email is required.",
    memberInvitationRemoveFailed: "Could not remove invitation.",
    memberRemoveFailed: "Could not remove member.",
    memberRoleUpdateFailed: "Could not update member role.",
    ownerTransferFailed: "Could not transfer workspace owner.",
    // Directory search text
    searchActiveUser: "active",
    searchDisabledUser: "disabled suspended",
    searchInstanceAdmin: "instance admin",
    // Invitation delivery
    deliveryEmailFailed: "Email failed",
    deliveryEmailNotConfigured: "Email not configured",
    deliveryEmailPending: "Email pending",
    deliveryEmailSent: "Email sent",
    invitePending: "Invite pending",
    // Counts and interpolations
    activeSessionsCount: (count: number) => `${count} active session${count === 1 ? "" : "s"}`,
    cleanupResultSummary: (expired: number, failed: number) => `${expired} expired, ${failed} failed`,
    fileCount: (count: number) => `${count} files`,
    grantsCount: (count: number) => `${count} connection${count === 1 ? "" : "s"}.`,
    importFailures: (count: number) => `Import failures ${count}`,
    instanceUserTotals: (users: number, admins: number) => `${users} accounts · ${admins} instance admins`,
    itemsOfTotal: (total: number, shown: number) => `${shown} of ${total}`,
    jobFailedItems: (count: number) => ` · ${count} failed items`,
    jobItemCounts: (items: number, mapped: number) => ` · ${items} items · ${mapped} mapped`,
    lastUsedAt: (date: string) => `Last used ${date}`,
    maintenanceRunSummary: (scanned: number, expired: number, failed: number) =>
      `${scanned} scanned · ${expired} expired · ${failed} failed`,
    orgMembersCount: (count: number) => `${count} organization member${count === 1 ? "" : "s"}`,
    pendingInvitesCount: (count: number) => `${count} pending invite${count === 1 ? "" : "s"}`,
    peopleCount: (count: number) => `${count} member${count === 1 ? "" : "s"}`,
    peopleOfTotal: (total: number, shown: number) => `${shown} of ${total} people`,
    removeNamed: (name: string) => `Remove ${name}`,
    transferContentTo: (name: string) => `Transfer content to ${name}`,
    userScopeCounts: (workspaces: number, organizations: number) =>
      ` · ${workspaces} workspaces · ${organizations} organizations`,
    verifiedAt: (date: string) => `Verified ${date}`,
    workspaceMemberCounts: (members: number, pages: number, databases: number) =>
      ` · ${members} members · ${pages} pages · ${databases} DBs`,
    workspacesCount: (count: number) => `${count} workspace${count === 1 ? "" : "s"}`,
    // Confirm dialogs
    confirmDeleteUser: (label: string) =>
      `Delete the account for ${label}? This user will no longer be able to sign in.`,
    confirmResetPassword: (label: string) =>
      `Reset the password for ${label} to a temporary password and revoke all sessions?`,
    confirmRevokeSessions: (label: string) => `Revoke all sign-in sessions for ${label}?`,
    // Navigation
    navAccountGroup: "Account",
    navAccountSecurity: "Account security",
    navAccountsSignup: "Accounts & signup",
    navAiConnections: "AI connections",
    navAuditLog: "Audit log",
    navBackup: "Backup",
    navImports: "Imports",
    navOverview: "Overview",
    navPoliciesDomains: "Policies & domains",
    navProfile: "Profile",
    navSecurityGroup: "Security",
    navServerGroup: "Server",
    navServerSecurity: "Security",
    navServerWorkspaces: "Workspaces",
    navSharingSecurity: "Sharing security",
    navSystem: "System",
    navUsage: "Usage",
    navUsageFiles: "Usage & files",
    navWorkspaceGroup: "Workspace",
    navWorkspaceMembers: "Workspace members",
    // Surface chrome
    accountConsole: "Account console",
    accountConsoleSubtitle: "Manage your profile, account security, and MCP and AI connections.",
    hanjiServer: "Hanji Server",
    instanceLabel: "Instance",
    serverConsole: "Server console",
    serverConsoleSubtitle: "Manage accounts, signup, and authentication across this entire instance.",
    workspaceConsole: "Workspace console",
    workspaceConsoleSubtitle: "Manage the current workspace's members, policies, security, and usage.",
    // Server overview section
    accountsTile: "Accounts",
    activeStorageTile: "Active storage",
    activeUsers: "Active users",
    failedImportsTile: "Failed imports",
    instanceAdminsTile: "Instance admins",
    lastUpdated: "Last updated",
    loadingServerStatus: "Loading server status...",
    noServerStatus: "No server status summary.",
    operationalStatus: "Operational status",
    pagesDbsTile: "Pages/DBs",
    serverOverviewMeta: "Review instance-wide accounts, workspaces, files, and import status in one place.",
    serverOverviewTitle: "Server overview",
    workspacesTile: "Workspaces",
    // Instance accounts section
    allAccountsTile: "All accounts",
    createAccount: "Create account",
    createAccountFailed: "Could not create the account.",
    disabledAccountsTile: "Disabled accounts",
    enterEmail: "Enter an email.",
    instanceMeta: "Manage server-wide accounts, signup, and instance admin access.",
    instanceTitle: "Server accounts & signup",
    loadingAccounts: "Loading accounts...",
    makeAdmin: "Make admin",
    namePlaceholder: "Name",
    newAccountEmailPlaceholder: "New account email",
    newAccountPasswordPlaceholder: "Password (blank for temporary)",
    noInstanceAccounts: "No instance accounts.",
    removeAdmin: "Remove admin",
    restore: "Restore",
    deactivate: "Deactivate",
    reactivate: "Reactivate",
    searchAccountsPlaceholder: "Search accounts",
    signupTitle: "Signup",
    signupHelpInviteOnly: "Only invited emails can create accounts on this instance.",
    signupHelpPublic: "New users can create their own accounts on this instance.",
    signupHelpVerified: "Only verified-domain or invited emails can create accounts on this instance.",
    temporaryPasswordCopied: "Temporary password copied.",
    temporaryPasswordPrefix: "Temporary password:",
    verifiedAccountsTile: "Verified accounts",
    // Server workspaces section
    searchWorkspacesPlaceholder: "Search workspaces",
    serverWorkspacesMeta: "Review the owners, members, pages, files, and import status of every workspace.",
    serverWorkspacesTitle: "Server workspaces",
    noWorkspaces: "No workspaces.",
    // Server security section
    available: "Available",
    awaiting: "Pending",
    mfaResetTile: "MFA reset",
    revokeSessionsButton: "Revoke sessions",
    revokeSessionsFailed: "Could not revoke the sessions.",
    serverSecurityMeta: "Manage instance admins, disabled accounts, password resets, and session revocation.",
    serverSecurityTitle: "Server security",
    sessionRevocationTile: "Session revocation",
    temporaryPasswordButton: "Temporary password",
    resetPasswordFailed: "Could not reset the password.",
    unavailable: "Unavailable",
    // Server audit section
    allActions: "All actions",
    loadingAuditLog: "Loading audit log...",
    noAuditLog: "No audit log entries.",
    serverAuditMeta: "Review instance admin actions and organization audit events together.",
    serverAuditTitle: "Server audit log",
    // Server jobs section
    allStatuses: "All statuses",
    loadingImportJobs: "Loading import jobs...",
    noImportJobs: "No import jobs.",
    serverJobsMeta: "Track the phases, failures, and mapping status of Notion migration jobs across the server.",
    serverJobsTitle: "Import jobs",
    // Server usage section
    expiredTile: "Expired",
    filesTile: "Files",
    pendingTile: "Pending",
    recentCleanup: "Recent file cleanup",
    serverUsageMeta: "Review server-wide file status, storage, and cleanup results.",
    serverUsageTitle: "Server usage & files",
    // Server backup section
    backupTitle: "Backup & restore",
    downloadableTables: "Downloadable tables",
    downloadSnapshot: "Download snapshot",
    lastGenerated: "Last generated",
    onHold: "On hold",
    productData: "Product data",
    restoreUiTile: "Restore UI",
    serverBackupMeta: "Download product data snapshots and review what can be restored.",
    snapshotDownloaded: "Server snapshot downloaded.",
    snapshotFailed: "Could not create the snapshot.",
    snapshotScope: "Snapshot scope",
    // Server system section
    configured: "Configured",
    loadingSystem: "Loading system settings...",
    noSystemSummary: "No system settings summary.",
    notConfigured: "Not configured",
    serverSystemMeta: "Review operational environment values and the EdgeBase admin dependencies the server console is replacing.",
    serverSystemTitle: "Server system",
    // Workspace section
    changeIcon: "Change icon",
    deleteAdminRequired: "Workspace admin access is required.",
    deleteConfirmAriaLabel: "Workspace name to confirm deletion",
    deleteNameMismatch: "Enter the workspace name exactly.",
    deleteWorkspace: "Delete workspace",
    deleteWorkspaceConfirmLabel: "Type the workspace name to delete it.",
    deleteWorkspaceDesc: "Pages, databases, and file records are deleted with it.",
    deleteWorkspaceFailed: "Could not delete the workspace.",
    deleting: "Deleting...",
    iconField: "Icon",
    lastWorkspaceError: "The last workspace cannot be deleted.",
    nameField: "Name",
    needAnotherWorkspace: "You can delete this only when another workspace exists.",
    onlyAdminsDelete: "Only workspace admins can delete it.",
    workspaceDeleted: "Workspace deleted.",
    workspaceSectionTitle: "Workspace",
    workspaceUrlField: "Workspace URL",
    workspaceUrlSaving: "Saving workspace URL...",
    // Preferences and profile
    accountEmail: "Account email",
    accountId: "Account ID",
    displayNamePlaceholder: "Display name",
    emailPlaceholder: "Email",
    preferencesTitle: "Preferences",
    profileIconField: "Profile icon",
    saveProfileButton: "Save profile",
    themeField: "Theme",
    // Account security section
    activeSessionsDesc: "Review the browser sessions connected to this account.",
    activeSessionsTitle: "Active sessions",
    advancedUriSummary: "Advanced: view the setup URI",
    applyVerification: "Apply verification",
    authKeyCopied: "Authenticator key copied.",
    changePasswordButton: "Change password",
    codeOrPasswordPlaceholder: "6-digit code or password",
    confirmNewPassword: "Confirm new password",
    copyCodes: "Copy codes",
    copyKey: "Copy key",
    copyUri: "Copy URI",
    current: "Current",
    currentPassword: "Current password",
    currentSession: "Current session",
    enterCodeDesc: "Enter the code and press Apply verification to turn on two-step verification and reveal your recovery codes.",
    enterCodeOrPassword: "Enter an authenticator code or your password.",
    enterCodeTitle: "Enter the app's 6-digit code",
    enterCurrentAndNewPassword: "Enter your current and new passwords.",
    enterSixDigitCode: "Enter the 6-digit code shown in your authenticator app.",
    loadAccountSecurityFailed: "Could not load account security.",
    loadingSessions: "Loading sessions...",
    manageRecoveryDesc: "Generate new codes if you lost the saved ones. Existing unused codes stop working.",
    manageRecoveryTitle: "Manage recovery codes",
    manualKeyLabel: "Manual entry key",
    mfaDisabledDesc: "Add an authenticator app code to protect password sign-in.",
    mfaDisabledNotice: "Two-step verification is off.",
    mfaDisableFailed: "Could not turn off two-step verification.",
    mfaEnabledDesc: "An authenticator app code is required after password sign-in.",
    mfaEnabledNotice: "Two-step verification is on. Save your recovery codes.",
    mfaEnrollFailed: "Could not start two-step verification setup.",
    mfaOff: "Two-step verification off",
    mfaOn: "Two-step verification on",
    mfaSetupAriaLabel: "Two-step verification setup",
    mfaSetupIntro: "Add Hanji to your authenticator app, then enter the newest 6-digit code the app shows.",
    mfaTitle: "Two-step verification",
    mfaTurnOff: "Turn off two-step verification",
    mfaTurnOn: "Turn on two-step verification",
    mfaVerifyFailed: "Could not verify the two-step verification code.",
    newPassword: "New password",
    newPasswordMismatch: "The new password confirmation does not match.",
    newPasswordTooShort: "The new password must be at least 8 characters.",
    noActiveSessions: "No active sessions.",
    passwordChangedNotice: "Password changed. Other devices need to sign in again.",
    passwordChangeFailed: "Could not change the password.",
    passwordDesc: "Confirm your current password, then change it to a new one.",
    passwordTitle: "Password",
    qrAlt: "Two-step verification QR code to scan with Google Authenticator",
    qrCodeFailed: "Could not create the QR code. Use the manual entry key below.",
    qrCreating: "Creating the QR code...",
    qrFallbackSummary: "Can't scan the QR code?",
    recoveryCodesCopied: "Recovery codes copied.",
    recoveryCodesDesc: "Save these now. Each code can be used once when your authenticator app is unavailable.",
    recoveryCodesKeepSafe: "You may not be able to see these codes again, so store them in a password manager or another safe place.",
    recoveryCodesTitle: "Recovery codes",
    recoveryFileCreated: "Recovery code file created.",
    recoveryRegeneratedNotice: "Recovery codes regenerated.",
    recoveryRegenerateFailed: "Could not regenerate recovery codes.",
    regenerateCodes: "Regenerate codes",
    revokeOtherSessions: "Revoke other sessions",
    saveAsText: "Save as text",
    scanQrDesc: "Add a new account in an app like Google Authenticator, 1Password, or Authy.",
    scanQrTitle: "Scan the QR code in your authenticator app",
    setupInProgress: "Setup in progress",
    setupUriCopied: "Setup URI copied.",
    setupUriLabel: "Setup URI",
    unknownDevice: "Unknown device",
    // MCP section
    accessTokenCopied: "Access token copied.",
    aiConnectionRevoked: "AI connection revoked.",
    allAccessible: "All accessible",
    connectedAiTitle: "Connected AI apps",
    copyAccess: "Copy access",
    copyRefresh: "Copy refresh",
    copyUrl: "Copy URL",
    createToken: "Create token",
    disconnect: "Disconnect",
    loadingConnectionList: "Loading connections...",
    loadingConnections: "Loading connections...",
    loadingEllipsis: "Loading...",
    manualTokenCreated: "Manual MCP token created. This value will not be shown again.",
    manualTokensDesc: "Only for MCP clients without OAuth support. Prefer the OAuth connection through the MCP URL above when possible.",
    manualTokensTitle: "Manual tokens",
    mcpEmptyHint: "Add the MCP URL in your ChatGPT app settings and it will show up here.",
    mcpMeta: "Access Hanji pages and databases from MCP-enabled AI apps.",
    mcpScopeNote: "The default scope is every workspace you can access. Each action still re-checks the product permissions and workspace_id selection required by each MCP tool.",
    mcpServerUrlDesc: "Add this address to MCP clients such as ChatGPT, Claude, and Cursor. OAuth-capable clients are sent to the Hanji approval screen automatically.",
    mcpServerUrlTitle: "MCP server URL",
    mcpUrlCopied: "MCP URL copied.",
    mcpUrlUnavailable: "Could not load the MCP URL.",
    newManualTokenDesc: "Shown only once. Paste it into the client settings that need it.",
    newManualTokenTitle: "New manual MCP token",
    noAiApps: "No AI apps connected yet.",
    readOnly: "Read-only",
    readWrite: "Read/write",
    refreshTokenCopied: "Refresh token copied.",
    revokedBadge: "Revoked",
    selectedScope: "Selected scope",
    // People section
    addMembers: "Add members",
    cancelInvite: "Cancel invite",
    loadingMembers: "Loading members...",
    makeOwner: "Make owner",
    noMembers: "No members.",
    searchPeoplePlaceholder: "Search people",
    // Workspace security section
    noOrganizationYet: "No organization is connected yet.",
    orgSecurityAdminRequired: "Organization security admin access is required.",
    sharingPoliciesTitle: "Sharing policies",
    workspaceSecurityMeta: "Manage public sharing, external invites, and file download policies.",
    workspaceSecurityTitle: "Workspace security",
    // Organization section
    addDomain: "Add domain",
    addGroup: "Add group",
    addPerson: "Add person",
    domainPolicyAddHint: "Add a verified domain to distinguish internal members from external guests.",
    domainPolicyInviteVerified: "Verified domains are used for internal member and admin invites. External emails can be invited as guests.",
    domainPolicyVerifiedRequired: "Members and admins must use a verified organization domain. External emails go through the guest path.",
    domainSignupTitle: "Domain signup",
    domainsTitle: "Domains",
    groupsTitle: "Groups",
    loadingOrganization: "Loading organization...",
    noContentToTransfer: "No content to transfer",
    noDomains: "No organization domains yet.",
    noGroups: "No organization groups yet.",
    noMatchingAudit: "No matching audit log entries.",
    noOrgMembers: "No organization members.",
    orgAdminRequired: "Organization admin access is required.",
    organizationAdminTitle: "Organization admin",
    organizationFallback: "Organization",
    workspaceCreationTitle: "Workspace creation",
    // Usage section
    deletedBytes: "Deleted records",
    lastCleanup: "Last cleanup",
    cleanupResult: "Cleanup results",
    limitTile: "Limit",
    loadingUsage: "Loading usage...",
    noFilesYet: "No files yet.",
    noLimit: "No limit",
    orgUsageTitle: "Organization usage",
    storageLimitField: "Storage limit",
    uploadedBytes: "Uploaded bytes",
    workspaceUsageTitle: "Workspace usage",
    // Local data lock panel
    changePassphrase: "Change passphrase",
    confirmNewPassphrase: "Confirm new passphrase",
    confirmPassphrase: "Confirm passphrase",
    currentPassphrase: "Current passphrase",
    enterCurrentPassphrase: "Enter the current passphrase to turn off the lock.",
    localLockForgetWarning: "If you forget the passphrase, offline edits on this device that haven't synced yet are permanently lost — there is no way to recover them.",
    localLockOffDesc: "Lock this device's offline cache with a passphrase-based key. The local cache is reset when you turn it on or off.",
    localLockOnDesc: "In use — offline data on this device is sealed with a passphrase-locked key.",
    localLockTitle: "Local data lock",
    lockDisabledNotice: "Local data lock is off. The local cache on this device has been reset.",
    lockEnabledNotice: "Local data lock is on. Offline data on this device is now protected by your passphrase.",
    lockOffWithPass: "Turn off lock (current passphrase required)",
    lockOn: "Turn on lock",
    lockPassphrase: "Lock passphrase",
    lockPendingChanges: "Some changes are still waiting to sync. Try again after sync finishes while online.",
    lockUnavailable: "Local lock is not available in this browser.",
    lockWrongPassphrase: "The current passphrase is incorrect.",
    newPassphrase: "New passphrase",
    newPassphraseMismatch: "The new passphrase confirmation does not match.",
    newPassphraseTooShort: "The new passphrase must be at least 8 characters.",
    passphraseChangedNotice: "Local lock passphrase changed.",
    passphraseMismatch: "The passphrase confirmation does not match.",
    passphraseTooShort: "The passphrase must be at least 8 characters.",
  },
  ko: {
    // Common actions
    add: "추가",
    cleanUp: "정리",
    copy: "복사",
    delete: "삭제",
    invite: "초대",
    refresh: "새로고침",
    remove: "제거",
    revoke: "해제",
    save: "저장",
    verify: "인증",
    // Common labels
    adminOnlyNotice: "이 화면은 조직 소유자, 관리자, 보안 관리자, 결제 관리자만 사용할 수 있습니다.",
    adminRequired: "관리자 권한이 필요합니다.",
    clipboardCopyFailed: "클립보드에 복사할 수 없습니다.",
    me: "나",
    member: "멤버",
    myAccount: "내 계정",
    none: "없음",
    noSearchResults: "검색 결과가 없습니다.",
    untitledWorkspace: "제목 없는 워크스페이스",
    // Roles
    roleAdmin: "관리자",
    roleBillingAdmin: "결제 관리자",
    roleGuest: "게스트",
    roleMember: "멤버",
    roleOwner: "소유자",
    roleSecurityAdmin: "보안 관리자",
    // Theme
    themeDark: "다크",
    themeLight: "라이트",
    themeSystem: "시스템",
    // Policies
    policyMembers: "멤버",
    policyOwnersAdmins: "소유자와 관리자",
    signupInviteOnly: "초대만 허용",
    signupPublic: "누구나",
    signupVerifiedDomains: "인증 도메인 또는 초대",
    domainSignupVerified: "인증된 도메인",
    sharingExternalEmail: "외부 이메일",
    sharingFileDownloads: "파일 다운로드",
    sharingFullAccess: "전체 권한",
    sharingGuests: "게스트",
    sharingPublicWeb: "공개 웹 공유",
    // Audit action filter options
    auditAllEvents: "모든 이벤트",
    auditLoginAttempt: "로그인 시도",
    auditSettingsUpdate: "설정 변경",
    auditMemberDeactivate: "비활성화",
    auditMemberReactivate: "재활성화",
    auditMemberRoleUpdate: "조직 역할 변경",
    auditMemberRemove: "구성원 제거",
    auditOwnerTransfer: "소유자 변경",
    auditDomainCreate: "도메인 추가",
    auditDomainVerify: "도메인 인증",
    auditDomainRemove: "도메인 제거",
    auditWorkspaceCreate: "워크스페이스 생성",
    auditWorkspaceDelete: "워크스페이스 삭제",
    auditWorkspaceOwnerTransfer: "워크스페이스 소유자 변경",
    auditInviteEmailSent: "초대 메일 발송",
    auditInviteEmailFailed: "초대 메일 실패",
    auditInviteEmailNotConfigured: "초대 메일 미설정",
    auditWebShare: "웹 공유",
    auditPagePermissionGrant: "페이지 권한 부여",
    auditPagePermissionUpdate: "페이지 권한 변경",
    auditPagePermissionRevoke: "페이지 권한 해제",
    auditExportPage: "페이지 내보내기",
    auditExportDatabase: "데이터베이스 내보내기",
    auditExportWorkspace: "워크스페이스 내보내기",
    auditPageDelete: "페이지 삭제",
    auditDatabaseRowDelete: "데이터베이스 행 삭제",
    // Statuses
    statusActive: "활성",
    statusDeactivated: "비활성",
    statusPending: "대기 중",
    statusRejected: "거절됨",
    statusVerified: "인증됨",
    instanceAdminBadge: "인스턴스 관리자",
    // Server audit helpers
    scopeOrganization: "조직",
    scopeServer: "서버",
    auditTarget: (target: string) => `대상 ${target}`,
    auditWorkspaceRef: (id: string) => `워크스페이스 ${id}`,
    auditActorRef: (id: string) => `작업자 ${id}`,
    auditSignupPolicyRef: (policy: string) => `가입 정책 ${policy}`,
    auditDisabledRef: (disabled: boolean) => `비활성 ${disabled ? "예" : "아니오"}`,
    auditSessionsRevoked: "세션 종료",
    // Import job statuses
    jobCancelled: "취소",
    jobCompleted: "완료",
    jobDiscovering: "탐색 중",
    jobFailed: "실패",
    jobQueued: "대기",
    jobReady: "적용 대기",
    jobUnknown: "알 수 없음",
    // Health statuses
    healthAttention: "확인 필요",
    healthMissing: "미설정",
    healthOk: "정상",
    // Module helper errors
    codeOrPasswordMismatch: "코드 또는 비밀번호가 맞지 않습니다.",
    recoveryCodeMismatch: "복구 코드를 확인해 다시 입력하세요.",
    storageLimitInvalid: "저장공간 제한은 0 이상이어야 합니다.",
    totpCodeMismatch: "인증 앱 코드가 맞지 않습니다. 앱에서 새로 표시된 6자리 코드를 확인해 다시 입력하세요.",
    // Member management errors
    memberAddFailed: "멤버를 추가하지 못했어요.",
    memberEmailInvalid: "올바른 이메일 주소를 입력해 주세요.",
    memberEmailRequired: "이메일을 입력해 주세요.",
    memberInvitationRemoveFailed: "초대를 취소하지 못했어요.",
    memberRemoveFailed: "멤버를 제거하지 못했어요.",
    memberRoleUpdateFailed: "멤버 역할을 변경하지 못했어요.",
    ownerTransferFailed: "워크스페이스 소유자를 이전하지 못했어요.",
    // Directory search text
    searchActiveUser: "active 활성",
    searchDisabledUser: "disabled 비활성 정지",
    searchInstanceAdmin: "instance admin 인스턴스 관리자",
    // Invitation delivery
    deliveryEmailFailed: "메일 발송 실패",
    deliveryEmailNotConfigured: "메일 미설정",
    deliveryEmailPending: "메일 대기 중",
    deliveryEmailSent: "메일 발송됨",
    invitePending: "초대 대기",
    // Counts and interpolations
    activeSessionsCount: (count: number) => `${count}개 활성 세션`,
    cleanupResultSummary: (expired: number, failed: number) => `만료 ${expired}개, 실패 ${failed}개`,
    fileCount: (count: number) => `${count}개`,
    grantsCount: (count: number) => `${count}개 연결이 있습니다.`,
    importFailures: (count: number) => `가져오기 실패 ${count}`,
    instanceUserTotals: (users: number, admins: number) => `${users}명 · 인스턴스 관리자 ${admins}명`,
    itemsOfTotal: (total: number, shown: number) => `${total}개 중 ${shown}개`,
    jobFailedItems: (count: number) => ` · 실패 항목 ${count}개`,
    jobItemCounts: (items: number, mapped: number) => ` · 항목 ${items}개 · 매핑 ${mapped}개`,
    lastUsedAt: (date: string) => `마지막 사용 ${date}`,
    maintenanceRunSummary: (scanned: number, expired: number, failed: number) =>
      `스캔 ${scanned}개 · 만료 ${expired}개 · 실패 ${failed}개`,
    orgMembersCount: (count: number) => `조직 구성원 ${count}명`,
    pendingInvitesCount: (count: number) => `대기 중인 초대 ${count}개`,
    peopleCount: (count: number) => `${count}명`,
    peopleOfTotal: (total: number, shown: number) => `${total}명 중 ${shown}명`,
    removeNamed: (name: string) => `${name} 제거`,
    transferContentTo: (name: string) => `${name}에게 콘텐츠 이전`,
    userScopeCounts: (workspaces: number, organizations: number) =>
      ` · 워크스페이스 ${workspaces}개 · 조직 ${organizations}개`,
    verifiedAt: (date: string) => `인증됨 ${date}`,
    workspaceMemberCounts: (members: number, pages: number, databases: number) =>
      ` · 멤버 ${members}명 · 페이지 ${pages}개 · DB ${databases}개`,
    workspacesCount: (count: number) => `${count}개 워크스페이스`,
    // Confirm dialogs
    confirmDeleteUser: (label: string) =>
      `${label} 계정을 삭제할까요? 이 사용자는 더 이상 로그인할 수 없습니다.`,
    confirmResetPassword: (label: string) =>
      `${label} 계정의 비밀번호를 임시 비밀번호로 재설정하고 모든 세션을 종료할까요?`,
    confirmRevokeSessions: (label: string) => `${label} 계정의 모든 로그인 세션을 종료할까요?`,
    // Navigation
    navAccountGroup: "계정",
    navAccountSecurity: "계정 보안",
    navAccountsSignup: "계정과 가입",
    navAiConnections: "AI 연결",
    navAuditLog: "감사 로그",
    navBackup: "백업",
    navImports: "가져오기",
    navOverview: "개요",
    navPoliciesDomains: "정책과 도메인",
    navProfile: "프로필",
    navSecurityGroup: "보안",
    navServerGroup: "서버",
    navServerSecurity: "보안",
    navServerWorkspaces: "워크스페이스",
    navSharingSecurity: "공유 보안",
    navSystem: "시스템",
    navUsage: "사용량",
    navUsageFiles: "사용량과 파일",
    navWorkspaceGroup: "워크스페이스",
    navWorkspaceMembers: "워크스페이스 멤버",
    // Surface chrome
    accountConsole: "계정 콘솔",
    accountConsoleSubtitle: "내 프로필, 계정 보안, MCP와 AI 연결을 관리합니다.",
    hanjiServer: "Hanji 서버",
    instanceLabel: "인스턴스",
    serverConsole: "서버 콘솔",
    serverConsoleSubtitle: "계정, 회원가입, 인증 운영을 이 인스턴스 전체 기준으로 관리합니다.",
    workspaceConsole: "워크스페이스 콘솔",
    workspaceConsoleSubtitle: "현재 워크스페이스의 멤버, 정책, 보안, 사용량을 관리합니다.",
    // Server overview section
    accountsTile: "계정",
    activeStorageTile: "활성 저장공간",
    activeUsers: "활성 사용자",
    failedImportsTile: "실패한 가져오기",
    instanceAdminsTile: "인스턴스 관리자",
    lastUpdated: "마지막 갱신",
    loadingServerStatus: "서버 상태를 불러오는 중...",
    noServerStatus: "서버 상태 요약이 없습니다.",
    operationalStatus: "운영 상태",
    pagesDbsTile: "페이지/DB",
    serverOverviewMeta: "인스턴스 전체 계정, 워크스페이스, 파일, 가져오기 상태를 한 화면에서 확인합니다.",
    serverOverviewTitle: "서버 개요",
    workspacesTile: "워크스페이스",
    // Instance accounts section
    allAccountsTile: "전체 계정",
    createAccount: "계정 만들기",
    createAccountFailed: "계정을 만들지 못했습니다.",
    disabledAccountsTile: "비활성 계정",
    enterEmail: "이메일을 입력하세요.",
    instanceMeta: "서버 전체 계정, 회원가입, 인스턴스 관리자 권한을 관리합니다.",
    instanceTitle: "서버 계정과 가입",
    loadingAccounts: "계정을 불러오는 중...",
    makeAdmin: "관리자 지정",
    namePlaceholder: "이름",
    newAccountEmailPlaceholder: "새 계정 이메일",
    newAccountPasswordPlaceholder: "비밀번호 비우면 임시 발급",
    noInstanceAccounts: "인스턴스 계정이 없습니다.",
    removeAdmin: "관리자 해제",
    restore: "복구",
    deactivate: "비활성화",
    reactivate: "재활성화",
    searchAccountsPlaceholder: "계정 검색",
    signupTitle: "회원가입",
    signupHelpInviteOnly: "초대된 이메일만 이 인스턴스에 계정을 만들 수 있습니다.",
    signupHelpPublic: "이 인스턴스에서 새 사용자가 직접 계정을 만들 수 있습니다.",
    signupHelpVerified: "인증된 도메인 이메일 또는 초대된 이메일만 이 인스턴스에 계정을 만들 수 있습니다.",
    temporaryPasswordCopied: "임시 비밀번호를 복사했습니다.",
    temporaryPasswordPrefix: "임시 비밀번호:",
    verifiedAccountsTile: "인증 계정",
    // Server workspaces section
    searchWorkspacesPlaceholder: "워크스페이스 검색",
    serverWorkspacesMeta: "모든 워크스페이스의 소유자, 멤버, 페이지, 파일, 가져오기 상태를 확인합니다.",
    serverWorkspacesTitle: "서버 워크스페이스",
    noWorkspaces: "워크스페이스가 없습니다.",
    // Server security section
    available: "가능",
    awaiting: "대기",
    mfaResetTile: "MFA 초기화",
    revokeSessionsButton: "세션 종료",
    revokeSessionsFailed: "세션을 종료하지 못했습니다.",
    serverSecurityMeta: "인스턴스 관리자, 비활성 계정, 비밀번호 재설정, 세션 종료를 관리합니다.",
    serverSecurityTitle: "서버 보안",
    sessionRevocationTile: "세션 종료",
    temporaryPasswordButton: "임시 비밀번호",
    resetPasswordFailed: "비밀번호를 재설정하지 못했습니다.",
    unavailable: "불가",
    // Server audit section
    allActions: "전체 액션",
    loadingAuditLog: "감사 로그를 불러오는 중...",
    noAuditLog: "표시할 감사 로그가 없습니다.",
    serverAuditMeta: "인스턴스 관리자 작업과 조직 감사 이벤트를 함께 봅니다.",
    serverAuditTitle: "서버 감사 로그",
    // Server jobs section
    allStatuses: "전체 상태",
    loadingImportJobs: "가져오기 작업을 불러오는 중...",
    noImportJobs: "가져오기 작업이 없습니다.",
    serverJobsMeta: "Notion 마이그레이션 작업의 단계, 실패, 매핑 상태를 서버 전체 기준으로 확인합니다.",
    serverJobsTitle: "가져오기 작업",
    // Server usage section
    expiredTile: "만료",
    filesTile: "파일",
    pendingTile: "대기 중",
    recentCleanup: "최근 파일 정리",
    serverUsageMeta: "서버 전체 파일 상태, 저장공간, 정리 작업 결과를 확인합니다.",
    serverUsageTitle: "서버 사용량과 파일",
    // Server backup section
    backupTitle: "백업과 복원",
    downloadableTables: "다운로드 테이블",
    downloadSnapshot: "스냅샷 다운로드",
    lastGenerated: "최근 생성",
    onHold: "보류",
    productData: "제품 데이터",
    restoreUiTile: "복원 UI",
    serverBackupMeta: "제품 데이터 스냅샷을 내려받고, 복원 가능 범위를 확인합니다.",
    snapshotDownloaded: "서버 스냅샷을 내려받았습니다.",
    snapshotFailed: "스냅샷을 만들지 못했습니다.",
    snapshotScope: "스냅샷 범위",
    // Server system section
    configured: "설정됨",
    loadingSystem: "시스템 설정을 불러오는 중...",
    noSystemSummary: "시스템 설정 요약이 없습니다.",
    notConfigured: "미설정",
    serverSystemMeta: "운영 환경값과 서버 콘솔에서 대체 중인 EdgeBase admin 의존 항목을 확인합니다.",
    serverSystemTitle: "서버 시스템",
    // Workspace section
    changeIcon: "아이콘 변경",
    deleteAdminRequired: "워크스페이스 관리자 권한이 필요합니다.",
    deleteConfirmAriaLabel: "삭제 확인 워크스페이스 이름",
    deleteNameMismatch: "워크스페이스 이름을 정확히 입력해 주세요.",
    deleteWorkspace: "워크스페이스 삭제",
    deleteWorkspaceConfirmLabel: "삭제하려면 워크스페이스 이름을 입력하세요.",
    deleteWorkspaceDesc: "페이지, 데이터베이스, 파일 기록이 함께 삭제됩니다.",
    deleteWorkspaceFailed: "워크스페이스를 삭제하지 못했어요.",
    deleting: "삭제 중...",
    iconField: "아이콘",
    lastWorkspaceError: "마지막 워크스페이스는 삭제할 수 없습니다.",
    nameField: "이름",
    needAnotherWorkspace: "다른 워크스페이스가 있을 때만 삭제할 수 있습니다.",
    onlyAdminsDelete: "워크스페이스 관리자만 삭제할 수 있습니다.",
    workspaceDeleted: "워크스페이스를 삭제했습니다.",
    workspaceSectionTitle: "워크스페이스",
    workspaceUrlField: "워크스페이스 URL",
    workspaceUrlSaving: "워크스페이스 URL 저장 중...",
    // Preferences and profile
    accountEmail: "계정 이메일",
    accountId: "계정 ID",
    displayNamePlaceholder: "표시 이름",
    emailPlaceholder: "이메일",
    preferencesTitle: "기본 설정",
    profileIconField: "프로필 아이콘",
    saveProfileButton: "프로필 저장",
    themeField: "테마",
    // Account security section
    activeSessionsDesc: "이 계정에 연결된 브라우저 세션을 확인합니다.",
    activeSessionsTitle: "활성 세션",
    advancedUriSummary: "고급: 설정 URI 보기",
    applyVerification: "인증 적용",
    authKeyCopied: "인증 앱 키를 복사했습니다.",
    changePasswordButton: "비밀번호 변경",
    codeOrPasswordPlaceholder: "6자리 코드 또는 비밀번호",
    confirmNewPassword: "새 비밀번호 확인",
    copyCodes: "코드 복사",
    copyKey: "키 복사",
    copyUri: "URI 복사",
    current: "현재",
    currentPassword: "현재 비밀번호",
    currentSession: "현재 세션",
    enterCodeDesc: "코드를 입력한 뒤 인증 적용을 누르면 2단계 인증이 켜지고 복구 코드가 표시됩니다.",
    enterCodeOrPassword: "인증 앱 코드 또는 비밀번호를 입력하세요.",
    enterCodeTitle: "앱의 6자리 코드 입력",
    enterCurrentAndNewPassword: "현재 비밀번호와 새 비밀번호를 입력하세요.",
    enterSixDigitCode: "인증 앱에 표시된 6자리 코드를 입력하세요.",
    loadAccountSecurityFailed: "계정 보안 정보를 불러오지 못했습니다.",
    loadingSessions: "세션을 불러오는 중...",
    manageRecoveryDesc: "저장한 코드를 잃어버렸다면 새 코드를 생성하세요. 기존 미사용 코드는 중지됩니다.",
    manageRecoveryTitle: "복구 코드 관리",
    manualKeyLabel: "수동 입력 키",
    mfaDisabledDesc: "비밀번호 로그인을 보호하려면 인증 앱 코드를 추가하세요.",
    mfaDisabledNotice: "2단계 인증을 껐습니다.",
    mfaDisableFailed: "2단계 인증을 끄지 못했습니다.",
    mfaEnabledDesc: "비밀번호 로그인 뒤 인증 앱 코드가 필요합니다.",
    mfaEnabledNotice: "2단계 인증을 켰습니다. 복구 코드를 저장하세요.",
    mfaEnrollFailed: "2단계 인증 설정을 시작하지 못했습니다.",
    mfaOff: "2단계 인증 꺼짐",
    mfaOn: "2단계 인증 켜짐",
    mfaSetupAriaLabel: "2단계 인증 설정",
    mfaSetupIntro: "인증 앱에 Hanji을 추가한 뒤 앱에서 새로 표시되는 6자리 코드를 입력하세요.",
    mfaTitle: "2단계 인증",
    mfaTurnOff: "2단계 인증 끄기",
    mfaTurnOn: "2단계 인증 켜기",
    mfaVerifyFailed: "2단계 인증 코드를 확인하지 못했습니다.",
    newPassword: "새 비밀번호",
    newPasswordMismatch: "새 비밀번호 확인이 일치하지 않습니다.",
    newPasswordTooShort: "새 비밀번호는 8자 이상이어야 합니다.",
    noActiveSessions: "활성 세션이 없습니다.",
    passwordChangedNotice: "비밀번호를 변경했습니다. 다른 기기는 다시 로그인해야 합니다.",
    passwordChangeFailed: "비밀번호를 변경하지 못했습니다.",
    passwordDesc: "현재 비밀번호를 확인한 뒤 새 비밀번호로 변경합니다.",
    passwordTitle: "비밀번호",
    qrAlt: "Google Authenticator로 스캔할 2단계 인증 QR 코드",
    qrCodeFailed: "QR 코드를 만들 수 없습니다. 아래 수동 입력 키를 사용하세요.",
    qrCreating: "QR 코드를 만드는 중...",
    qrFallbackSummary: "QR을 스캔할 수 없나요?",
    recoveryCodesCopied: "복구 코드를 복사했습니다.",
    recoveryCodesDesc: "지금 저장해 두세요. 인증 앱을 사용할 수 없을 때 각 코드를 한 번씩 사용할 수 있습니다.",
    recoveryCodesKeepSafe: "이 코드는 다시 볼 수 없을 수 있으니 비밀번호 관리자나 안전한 곳에 보관하세요.",
    recoveryCodesTitle: "복구 코드",
    recoveryFileCreated: "복구 코드 파일을 만들었습니다.",
    recoveryRegeneratedNotice: "복구 코드를 새로 만들었습니다.",
    recoveryRegenerateFailed: "복구 코드를 새로 만들지 못했습니다.",
    regenerateCodes: "코드 재생성",
    revokeOtherSessions: "다른 세션 해제",
    saveAsText: "텍스트 저장",
    scanQrDesc: "Google Authenticator, 1Password, Authy 같은 앱에서 새 계정을 추가하세요.",
    scanQrTitle: "인증 앱에서 QR 코드 스캔",
    setupInProgress: "설정 진행 중",
    setupUriCopied: "설정 URI를 복사했습니다.",
    setupUriLabel: "설정 URI",
    unknownDevice: "알 수 없는 기기",
    // MCP section
    accessTokenCopied: "Access token을 복사했습니다.",
    aiConnectionRevoked: "AI 연결을 해제했습니다.",
    allAccessible: "접근 가능한 전체",
    connectedAiTitle: "연결된 AI 앱",
    copyAccess: "Access 복사",
    copyRefresh: "Refresh 복사",
    copyUrl: "URL 복사",
    createToken: "토큰 만들기",
    disconnect: "연결 해제",
    loadingConnectionList: "연결 목록을 불러오는 중...",
    loadingConnections: "연결을 불러오는 중...",
    loadingEllipsis: "불러오는 중...",
    manualTokenCreated: "수동 MCP 토큰을 만들었습니다. 이 값은 다시 표시되지 않습니다.",
    manualTokensDesc: "OAuth를 지원하지 않는 MCP 클라이언트에서만 사용합니다. 가능하면 위 MCP URL의 OAuth 연결을 사용하세요.",
    manualTokensTitle: "수동 토큰",
    mcpEmptyHint: "ChatGPT 앱 설정에서 MCP URL을 추가하면 여기에 표시됩니다.",
    mcpMeta: "MCP를 지원하는 AI 앱에서 Hanji 페이지와 데이터베이스에 접근합니다.",
    mcpScopeNote: "기본 범위는 내가 접근 가능한 전체 워크스페이스입니다. 실제 작업은 각 MCP tool이 요구하는 제품 권한과 workspace_id 선택을 다시 확인합니다.",
    mcpServerUrlDesc: "ChatGPT, Claude, Cursor 같은 MCP 클라이언트에 이 주소를 추가합니다. OAuth 지원 클라이언트는 Hanji 승인 화면으로 자동 이동합니다.",
    mcpServerUrlTitle: "MCP 서버 URL",
    mcpUrlCopied: "MCP URL을 복사했습니다.",
    mcpUrlUnavailable: "MCP URL을 불러올 수 없습니다.",
    newManualTokenDesc: "지금만 표시됩니다. 필요한 클라이언트 설정에 붙여넣으세요.",
    newManualTokenTitle: "새 수동 MCP 토큰",
    noAiApps: "아직 연결된 AI 앱이 없습니다.",
    readOnly: "읽기 전용",
    readWrite: "읽기/쓰기",
    refreshTokenCopied: "Refresh token을 복사했습니다.",
    revokedBadge: "해제됨",
    selectedScope: "선택 범위",
    // People section
    addMembers: "멤버 추가하기",
    cancelInvite: "초대 취소",
    loadingMembers: "멤버를 불러오는 중...",
    makeOwner: "소유자로 변경",
    noMembers: "멤버가 없습니다.",
    searchPeoplePlaceholder: "사람 검색",
    // Workspace security section
    noOrganizationYet: "아직 조직이 연결되지 않았습니다.",
    orgSecurityAdminRequired: "조직 보안 관리자 권한이 필요합니다.",
    sharingPoliciesTitle: "공유 정책",
    workspaceSecurityMeta: "공개 공유, 외부 초대, 파일 다운로드 정책을 관리합니다.",
    workspaceSecurityTitle: "워크스페이스 보안",
    // Organization section
    addDomain: "도메인 추가",
    addGroup: "그룹 추가",
    addPerson: "사람 추가",
    domainPolicyAddHint: "인증된 도메인을 추가하면 내부 멤버와 외부 게스트를 구분할 수 있습니다.",
    domainPolicyInviteVerified: "내부 멤버와 관리자 초대에는 인증된 도메인을 사용합니다. 외부 이메일은 게스트로 초대할 수 있습니다.",
    domainPolicyVerifiedRequired: "멤버와 관리자는 인증된 조직 도메인을 사용해야 합니다. 외부 이메일은 게스트 경로로 처리됩니다.",
    domainSignupTitle: "도메인 가입",
    domainsTitle: "도메인",
    groupsTitle: "그룹",
    loadingOrganization: "조직을 불러오는 중...",
    noContentToTransfer: "넘길 콘텐츠 없음",
    noDomains: "아직 조직 도메인이 없습니다.",
    noGroups: "아직 조직 그룹이 없습니다.",
    noMatchingAudit: "일치하는 감사 로그가 없습니다.",
    noOrgMembers: "조직 구성원이 없습니다.",
    orgAdminRequired: "조직 관리자 권한이 필요합니다.",
    organizationAdminTitle: "조직 관리",
    organizationFallback: "조직",
    workspaceCreationTitle: "워크스페이스 생성",
    // Usage section
    deletedBytes: "삭제된 기록",
    lastCleanup: "마지막 정리",
    cleanupResult: "정리 결과",
    limitTile: "제한",
    loadingUsage: "사용량을 불러오는 중...",
    noFilesYet: "아직 파일이 없습니다.",
    noLimit: "제한 없음",
    orgUsageTitle: "조직 사용량",
    storageLimitField: "저장공간 제한",
    uploadedBytes: "업로드된 바이트",
    workspaceUsageTitle: "워크스페이스 사용량",
    // Local data lock panel
    changePassphrase: "암호 변경",
    confirmNewPassphrase: "새 암호 확인",
    confirmPassphrase: "암호 확인",
    currentPassphrase: "현재 암호",
    enterCurrentPassphrase: "잠금을 끄려면 현재 암호를 입력하세요.",
    localLockForgetWarning: "암호를 잊어버리면 이 기기에서 아직 동기화되지 않은 오프라인 편집 내용은 영구적으로 사라지고, 복구할 방법이 없어요.",
    localLockOffDesc: "이 기기의 오프라인 캐시를 암호 기반 키로 잠글 수 있어요. 켜고 끌 때 로컬 캐시는 초기화됩니다.",
    localLockOnDesc: "사용 중 — 이 기기의 오프라인 데이터는 암호로 잠긴 키로 봉인됩니다.",
    localLockTitle: "로컬 데이터 잠금",
    lockDisabledNotice: "로컬 데이터 잠금을 껐어요. 이 기기의 로컬 캐시는 초기화되었습니다.",
    lockEnabledNotice: "로컬 데이터 잠금을 켰어요. 이 기기의 오프라인 데이터가 암호로 보호됩니다.",
    lockOffWithPass: "잠금 끄기 (현재 암호 필요)",
    lockOn: "잠금 켜기",
    lockPassphrase: "잠금 암호",
    lockPendingChanges: "동기화 대기 중인 변경이 있어요. 온라인 상태에서 동기화가 끝난 뒤 다시 시도하세요.",
    lockUnavailable: "이 브라우저에서는 로컬 잠금을 사용할 수 없어요.",
    lockWrongPassphrase: "현재 암호가 올바르지 않아요.",
    newPassphrase: "새 암호",
    newPassphraseMismatch: "새 암호 확인이 일치하지 않아요.",
    newPassphraseTooShort: "새 암호는 8자 이상이어야 해요.",
    passphraseChangedNotice: "로컬 잠금 암호를 변경했어요.",
    passphraseMismatch: "암호 확인이 일치하지 않아요.",
    passphraseTooShort: "암호는 8자 이상이어야 해요.",
  },
} as const;

function workspaceSettingsLabels() {
  return pickLabels(WORKSPACE_SETTINGS_LABELS);
}

const LABELS = workspaceSettingsLabels();

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
  { value: "invite_only", label: LABELS.signupInviteOnly },
  { value: "verified_domains", label: LABELS.signupVerifiedDomains },
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
  return new Intl.DateTimeFormat(undefined, {
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
    event.targetType ? `Target: ${event.targetType}` : null,
    typeof metadata.domain === "string" ? metadata.domain : null,
    typeof metadata.email === "string" ? metadata.email : null,
    typeof metadata.method === "string" ? `Method: ${metadata.method.replace(/_/g, " ")}` : null,
    typeof metadata.phase === "string" ? `Phase: ${metadata.phase}` : null,
    typeof metadata.outcome === "string" ? `Outcome: ${metadata.outcome}` : null,
    typeof metadata.role === "string" ? `Role: ${metadata.role}` : null,
    typeof metadata.principalType === "string" ? `Principal: ${metadata.principalType}` : null,
    typeof metadata.enabled === "boolean" ? `Enabled: ${metadata.enabled ? "yes" : "no"}` : null,
    typeof metadata.pageCount === "number" ? `Pages: ${metadata.pageCount}` : null,
    typeof metadata.rowCount === "number" ? `Rows: ${metadata.rowCount}` : null,
    typeof metadata.deletedPageCount === "number" ? `Deleted pages: ${metadata.deletedPageCount}` : null,
    typeof metadata.storageLimitBytes === "number"
      ? `Limit: ${formatBytes(metadata.storageLimitBytes)}`
      : metadata.storageLimitBytes === null
        ? "Limit: none"
        : null,
    event.actorId ? `Actor: ${event.actorId}` : null,
  ].filter(Boolean);
  return bits.join(" · ") || "Organization event";
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
  if (value === "invite_only" || value === "verified_domains") return value;
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

function invitationDirectoryText(invitation: WorkspaceInvitation) {
  return [
    invitation.displayName,
    invitation.email,
    workspaceRoleLabel(invitation.role, false),
    LABELS.invitePending,
    invitation.emailDeliveryStatus,
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

function invitationDeliveryLabel(invitation: WorkspaceInvitation) {
  if (invitation.emailDeliveryStatus === "sent") return LABELS.deliveryEmailSent;
  if (invitation.emailDeliveryStatus === "failed") return LABELS.deliveryEmailFailed;
  if (invitation.emailDeliveryStatus === "not_configured") return LABELS.deliveryEmailNotConfigured;
  return LABELS.deliveryEmailPending;
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
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
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
  const [inviteDisplayName, setInviteDisplayName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceMember["role"]>("member");
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] =
    useState<SettingsNavSection>(
      serverAdminSurface ? "server-overview" : workspaceAdminSurface ? "workspace" : "preferences",
    );
  const [themePref, setThemePref] = useTheme();
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
    signupPolicy === "public"
      ? LABELS.signupHelpPublic
      : signupPolicy === "invite_only"
        ? LABELS.signupHelpInviteOnly
        : LABELS.signupHelpVerified;
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
        setWorkspaceError(settingsErrorMessage(error, "Could not update workspace."));
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
        setDomainError(settingsErrorMessage(error, "Could not update workspace URL."));
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
      setFileReportError(settingsErrorMessage(err, "Could not load storage report."));
    } finally {
      setFileReportLoading(false);
    }
  }, [canManageOrganizationBilling, canManageStorage, canViewStorage, organization?.id, workspace?.id]);

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
      setInstanceError(settingsErrorMessage(err, "Could not load instance users."));
    } finally {
      setInstanceLoading(false);
    }
  }, [applyInstanceAdminResult, serverAdminSurface]);

  useEffect(() => {
    if (!serverAdminSurface) return;
    void refreshInstanceAdmin();
  }, [refreshInstanceAdmin, serverAdminSurface, visibleSettingsSection]);

  const refreshMembers = useCallback(async () => {
    if (!workspace?.id || !canManageWorkspace) {
      const fallbackMember = currentMemberRef.current;
      setMembers(fallbackMember ? [fallbackMember] : []);
      setInvitations([]);
      setMemberError("");
      return;
    }
    setMembersLoading(true);
    setMemberError("");
    try {
      const result = await getWorkspaceMembersRemote(workspace.id);
      const nextMembers = result.members ?? [];
      setMembers(nextMembers);
      setInvitations(result.invitations ?? []);
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
        setMemberError(settingsErrorMessage(err, "Could not load members."));
      }
    } finally {
      setMembersLoading(false);
    }
  }, [
    applyOrganizationDirectory,
    applyWorkspaceMembers,
    canManageWorkspace,
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
      setOrganizationError(settingsErrorMessage(err, "Could not load organization."));
    } finally {
      setOrganizationLoading(false);
    }
  }, [applyOrganizationDirectory, canManageOrganization, organization?.id]);

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
      setMcpError(settingsErrorMessage(err, "Could not load AI connections."));
    } finally {
      setMcpLoading(false);
    }
  }, []);

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
      setFileReportError(settingsErrorMessage(err, "Could not clean up expired uploads."));
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
  const filteredInvitations = normalizedMemberQuery
    ? invitations.filter((invitation) => invitationDirectoryText(invitation).includes(normalizedMemberQuery))
    : invitations;
  const directoryTotal = renderedMembers.length + invitations.length;
  const filteredDirectoryTotal = filteredMembers.length + filteredInvitations.length;
  const memberDirectorySummary = normalizedMemberQuery
    ? LABELS.peopleOfTotal(directoryTotal, filteredDirectoryTotal)
    : `${LABELS.peopleCount(renderedMembers.length)} · ${LABELS.pendingInvitesCount(invitations.length)}`;
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
      setWorkspaceError(settingsErrorMessage(error, "Could not update workspace icon."));
    });
    closeIconPicker();
  }

  function updateProfileAvatar(icon: string | null) {
    setProfileAvatar(icon ?? "");
    setProfileError("");
    closeProfileIconPicker();
  }

  async function inviteMember(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!workspace?.id || !canManageWorkspace) return;
    const nextEmail = inviteEmail.trim();
    if (!nextEmail) {
      setMemberError(LABELS.memberEmailRequired);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      setMemberError(LABELS.memberEmailInvalid);
      return;
    }
    setMemberBusy("invite");
    setMemberError("");
    try {
      const result = await inviteWorkspaceMemberRemote({
        workspaceId: workspace.id,
        email: nextEmail,
        displayName: inviteDisplayName.trim() || null,
        role: inviteRole,
      });
      const nextMembers = result.members ?? [];
      setMembers(nextMembers);
      setInvitations(result.invitations ?? []);
      applyWorkspaceMembers(nextMembers, result.currentMember);
      setInviteDisplayName("");
      setInviteEmail("");
      setInviteRole("member");
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
      setInvitations(result.invitations ?? []);
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
      setInvitations(result.invitations ?? []);
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
      setInvitations(result.invitations ?? []);
      applyWorkspaceMembers(nextMembers, result.currentMember);
    } catch (err) {
      setMemberError(settingsErrorMessage(err, LABELS.memberRemoveFailed));
    } finally {
      setMemberBusy("");
    }
  }

  async function removeInvitation(invitation: WorkspaceInvitation) {
    if (!workspace?.id || !canManageWorkspace) return;
    setMemberBusy(`invite:${invitation.id}`);
    setMemberError("");
    try {
      const result = await removeWorkspaceInvitationRemote({
        workspaceId: workspace.id,
        invitationId: invitation.id,
      });
      const nextMembers = result.members ?? [];
      setMembers(nextMembers);
      setInvitations(result.invitations ?? []);
      applyWorkspaceMembers(nextMembers, result.currentMember);
    } catch (err) {
      setMemberError(settingsErrorMessage(err, LABELS.memberInvitationRemoveFailed));
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
      setOrganizationError(settingsErrorMessage(err, "Could not remove organization member."));
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
      setOrganizationError(settingsErrorMessage(err, "Could not transfer organization ownership."));
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
      setOrganizationError(settingsErrorMessage(err, "Could not update organization role."));
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
      setOrganizationError(settingsErrorMessage(err, "Could not update organization policy."));
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
      setInstanceError(settingsErrorMessage(err, "Could not update signup policy."));
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
      setInstanceError(settingsErrorMessage(err, disabled ? "Could not disable user." : "Could not restore user."));
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
      setInstanceError(settingsErrorMessage(err, "Could not delete user."));
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
      setInstanceError(settingsErrorMessage(err, "Could not update instance administrator."));
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
        `notionlike-product-snapshot-${snapshot.generatedAt.replace(/[:.]/g, "-")}.json`,
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
      setOrganizationError(settingsErrorMessage(err, "Could not update organization policy."));
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
      setOrganizationError(settingsErrorMessage(err, "Could not update organization policy."));
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
      setFileReportError(settingsErrorMessage(err, "Could not update storage limit."));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function createOrganizationGroup(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!organization?.id || !canManageOrganizationPeople) return;
    const name = organizationGroupDraft.trim();
    if (!name) {
      setOrganizationError("Group name is required.");
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
      setOrganizationError(settingsErrorMessage(err, "Could not create organization group."));
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
      setOrganizationError("Group name is required.");
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
      setOrganizationError(settingsErrorMessage(err, "Could not update organization group."));
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
      setOrganizationError(settingsErrorMessage(err, "Could not delete organization group."));
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
      setOrganizationError(settingsErrorMessage(err, "Could not add group member."));
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
      setOrganizationError(settingsErrorMessage(err, "Could not remove group member."));
    } finally {
      setOrganizationBusy("");
    }
  }

  async function addOrganizationDomain(e: ReactFormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!organization?.id || !canManageOrganizationSecurity) return;
    const domain = organizationDomainDraft.trim();
    if (!domain) {
      setOrganizationError("Domain is required.");
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
      setOrganizationError(settingsErrorMessage(err, "Could not add domain."));
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
      setOrganizationError(settingsErrorMessage(err, "Could not verify domain."));
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
      setOrganizationError(settingsErrorMessage(err, "Could not remove domain."));
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
      setInvitations(result.invitations ?? []);
      applyWorkspaceMembers(nextMembers, nextMember);
      setProfileDisplayName(firstTrimmed(nextMember?.displayName, profileSeedDisplayName));
      setProfileEmail(firstTrimmed(nextMember?.email, signedInEmail));
      setProfileAvatar(firstTrimmed(nextMember?.avatar, profileSeedAvatar));
    } catch (err) {
      setProfileError(settingsErrorMessage(err, "Could not update profile."));
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
      setMcpError(settingsErrorMessage(err, "Could not create MCP token."));
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
      setMcpError(settingsErrorMessage(err, "Could not revoke MCP connection."));
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
      setSecurityError("Use sign out to end the current session.");
      return;
    }
    setSecurityBusy(`session:${session.id}`);
    setSecurityError("");
    setSecurityNotice("");
    try {
      await revokeAuthSessionRemote(session.id);
      setSecurityNotice("Session revoked.");
      await refreshSecurity();
    } catch (err) {
      setSecurityError(settingsErrorMessage(err, "Could not revoke session."));
    } finally {
      setSecurityBusy("");
    }
  }

  async function revokeOtherSessions() {
    if (!hasCurrentSessionMarker) {
      setSecurityError("Refresh sessions first so the current session can be identified.");
      return;
    }
    if (!otherAuthSessions.length) {
      setSecurityNotice("No other sessions to revoke.");
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
      setSecurityError(settingsErrorMessage(err, "Could not revoke other sessions."));
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
        <aside className={styles.nav}>
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
        </aside>

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

            <div className={styles.storageGrid} aria-label="Server account summary">
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
              <div className={styles.policyOptions} role="radiogroup" aria-label="Instance signup policy">
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
                aria-label="New instance user email"
                type="email"
                autoComplete="off"
                disabled={instanceBusy === "user:create"}
                onChange={(e) => setNewInstanceUserEmail(e.target.value)}
              />
              <input
                value={newInstanceUserDisplayName}
                placeholder={LABELS.namePlaceholder}
                aria-label="New instance user display name"
                autoComplete="off"
                disabled={instanceBusy === "user:create"}
                onChange={(e) => setNewInstanceUserDisplayName(e.target.value)}
              />
              <input
                value={newInstanceUserPassword}
                placeholder={LABELS.newAccountPasswordPlaceholder}
                aria-label="New instance user password"
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
                  aria-label="Search instance users"
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
                  aria-label="Search server workspaces"
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
                aria-label="Filter server audit log"
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
                aria-label="Filter import jobs"
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
                aria-label="Workspace name"
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
                    aria-label="Workspace URL"
                    aria-describedby={domainError || domainBusy ? domainStatusId : undefined}
                    aria-invalid={domainError ? "true" : undefined}
                    disabled={!canManageWorkspace || domainBusy}
                    spellCheck={false}
                    placeholder="workspace-name"
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
                  aria-label="Change workspace icon"
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
              <div className={styles.themeOptions} role="radiogroup" aria-label="Theme">
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
                  aria-label="Change profile icon"
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
                aria-label="Profile display name"
                placeholder={LABELS.displayNamePlaceholder}
                autoComplete="name"
                onChange={(e) => setProfileDisplayName(e.target.value)}
              />
              <input
                value={profileEmail}
                aria-label="Profile email"
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
                    aria-label="Current password"
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
                    aria-label="New password"
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
                    aria-label="Confirm new password"
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
                      aria-label="Authenticator code or password"
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
                                <input readOnly value={mfaEnrollment.secret} aria-label="Authenticator secret" />
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
                                  <input readOnly value={mfaEnrollment.qrCodeUri} aria-label="Authenticator setup URI" />
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
                          aria-label="Setup verification code"
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
                      aria-label="Recovery code regeneration confirmation"
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
                  <span>Access token</span>
                  <code>{mcpCreatedToken.accessToken}</code>
                  <span>Refresh token</span>
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
                  aria-label="Search members and invitations"
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
                          aria-label={`Role for ${label}`}
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

            {!membersLoading && filteredMembers.length === 0 && filteredInvitations.length === 0 ? (
              <div className={styles.emptyState}>
                {normalizedMemberQuery ? LABELS.noSearchResults : LABELS.noMembers}
              </div>
            ) : null}

            {filteredInvitations.length > 0 ? (
              <div className={styles.memberList} aria-label="Pending invitations">
                {filteredInvitations.map((invitation) => {
                  const label = invitation.displayName?.trim() || invitation.email;
                  const roleLabel = workspaceRoleLabel(invitation.role, false);
                  return (
                    <div key={invitation.id} className={styles.memberRow}>
                      <span className={styles.memberAvatar} aria-hidden="true">
                        {label.trim().slice(0, 1).toUpperCase() || memberInitial}
                      </span>
                      <span className={styles.memberText}>
                        <strong>{label}</strong>
                        <span>
                          {invitation.email} · {LABELS.invitePending} · {invitationDeliveryLabel(invitation)}
                        </span>
                      </span>
                      <span className={styles.memberControls}>
                        <span className={styles.memberRole}>{roleLabel}</span>
                        <button
                          type="button"
                          className={styles.memberAction}
                          disabled={memberBusy === `invite:${invitation.id}`}
                          onClick={() => void removeInvitation(invitation)}
                        >
                          {LABELS.cancelInvite}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {canManageWorkspace && invitePanelOpen ? (
              <form className={styles.memberInvite} onSubmit={inviteMember}>
                <input
                  value={inviteEmail}
                  placeholder={LABELS.emailPlaceholder}
                  aria-label="Member email"
                  type="email"
                  autoComplete="off"
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
                <input
                  value={inviteDisplayName}
                  placeholder={LABELS.namePlaceholder}
                  aria-label="Member name"
                  autoComplete="off"
                  onChange={(e) => setInviteDisplayName(e.target.value)}
                />
                <select
                  value={inviteRole}
                  aria-label="New member role"
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
                  disabled={memberBusy === "invite"}
                >
                  {LABELS.invite}
                </button>
              </form>
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
                <div className={styles.policyOptions} role="radiogroup" aria-label="Workspace creation policy">
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
                <div className={styles.policyOptions} role="radiogroup" aria-label="Domain signup policy">
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
                              aria-label={`Group name for ${group.name}`}
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
                              aria-label={`Add member to ${group.name}`}
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
                    aria-label="Organization group name"
                    placeholder="Design, Engineering, Finance"
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
                    aria-label="Organization domain"
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
                  aria-label="Search organization members"
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
                          aria-label={`Organization role for ${label}`}
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
                          aria-label={`Reassign content owned by ${label}`}
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
                    aria-label="Filter audit log"
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
                        aria-label="Organization storage limit in MB"
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
              aria-label="Local lock passphrase"
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
              aria-label="Confirm local lock passphrase"
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
              aria-label="Current local lock passphrase"
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
              aria-label="New local lock passphrase"
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
              aria-label="Confirm new local lock passphrase"
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
