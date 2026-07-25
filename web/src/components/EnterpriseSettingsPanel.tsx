"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  approveOrganizationMcpClientRemote,
  createOrganizationLegalHoldRemote,
  createOrganizationScimTokenRemote,
  deleteOrganizationBillingRecordRemote,
  exportOrganizationAuditEventsRemote,
  exportOrganizationDiscoveryRemote,
  removeOrganizationMcpClientRemote,
  renameOrganizationMcpClientRemote,
  releaseOrganizationLegalHoldRemote,
  revokeOrganizationScimTokenRemote,
  setOrganizationMcpGovernanceEnabledRemote,
  updateOrganizationEnterpriseControlsRemote,
  upsertOrganizationBillingRecordRemote,
} from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import type {
  OrganizationApprovedMcpClient,
  OrganizationBillingRecord,
  OrganizationLegalHold,
} from "@/lib/types";
import { NotionAdminApiPanel } from "./NotionAdminApiPanel";
import styles from "./WorkspaceSettingsDialog.module.css";

type EnterpriseSettingsPanelProps = {
  canManageSecurity: boolean;
  canManageBilling: boolean;
};

type SsoDraft = {
  enabled: boolean;
  providerName: string;
  issuer: string;
  clientId: string;
  enforcement: "optional" | "required_for_verified_domains" | "required_for_all_members";
};

type ScimDraft = {
  enabled: boolean;
  requireVerifiedDomain: boolean;
};

type DlpDraft = {
  enabled: boolean;
  contentScanMode: "off" | "block";
  sensitiveTerms: string;
  blockPublicSharing: boolean;
  blockExternalSharing: boolean;
  blockFileDownloads: boolean;
  blockExports: boolean;
};

type ResidencyDraft = {
  primaryRegion: "global" | "us" | "eu" | "kr" | "apac";
  enforcementMode: "metadata_only" | "strict";
};

const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const flag = (value: unknown, fallback = false) => typeof value === "boolean" ? value : fallback;

function initialSso(config: Record<string, unknown> | null | undefined): SsoDraft {
  return {
    enabled: flag(config?.enabled),
    providerName: text(config?.providerName, "oidc:enterprise"),
    issuer: text(config?.issuer),
    clientId: text(config?.clientId),
    enforcement:
      config?.enforcement === "required_for_verified_domains" || config?.enforcement === "required_for_all_members"
        ? config.enforcement
        : "optional",
  };
}

function initialScim(config: Record<string, unknown> | null | undefined): ScimDraft {
  return {
    enabled: flag(config?.enabled),
    requireVerifiedDomain: flag(config?.requireVerifiedDomain, true),
  };
}

function initialDlp(config: Record<string, unknown> | null | undefined): DlpDraft {
  return {
    enabled: flag(config?.enabled),
    contentScanMode: config?.contentScanMode === "off" ? "off" : "block",
    sensitiveTerms: Array.isArray(config?.sensitiveTerms)
      ? config.sensitiveTerms.filter((term): term is string => typeof term === "string").join("\n")
      : "",
    blockPublicSharing: flag(config?.blockPublicSharing),
    blockExternalSharing: flag(config?.blockExternalSharing),
    blockFileDownloads: flag(config?.blockFileDownloads),
    blockExports: flag(config?.blockExports),
  };
}

function initialResidency(config: Record<string, unknown> | null | undefined): ResidencyDraft {
  const region = config?.primaryRegion;
  return {
    primaryRegion: region === "us" || region === "eu" || region === "kr" || region === "apac" ? region : "global",
    enforcementMode: config?.enforcementMode === "strict" ? "strict" : "metadata_only",
  };
}

function splitLines(value: string) {
  return Array.from(new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function downloadText(filename: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function EnterpriseSettingsPanel({
  canManageSecurity,
  canManageBilling,
}: EnterpriseSettingsPanelProps) {
  const { t, i18n } = useTranslation("workspaceSettingsDialog");
  const organization = useStore((state) => state.organization);
  const workspace = useStore((state) => state.workspace);
  const controls = useStore((state) => state.enterpriseControls);
  const domains = useStore((state) => state.organizationDomains);
  const members = useStore((state) => state.organizationMembers);
  const workspaces = useStore((state) => state.workspaces);
  const scimTokens = useStore((state) => state.organizationScimTokens);
  const legalHolds = useStore((state) => state.organizationLegalHolds);
  const auditExports = useStore((state) => state.organizationAuditExports);
  const discoveryExports = useStore((state) => state.organizationDiscoveryExports);
  const billingRecords = useStore((state) => state.organizationBillingRecords);
  const applyDirectory = useStore((state) => state.applyOrganizationDirectory);
  const notify = useStore((state) => state.notify);

  const [sso, setSso] = useState(() => initialSso(controls?.ssoConfig));
  const [scim, setScim] = useState(() => initialScim(controls?.scimConfig));
  const [dlp, setDlp] = useState(() => initialDlp(controls?.dlpPolicy));
  const [residency, setResidency] = useState(() => initialResidency(controls?.dataResidencyPolicy));
  const [retentionDays, setRetentionDays] = useState(() => String(controls?.auditPolicy?.retentionDays ?? 365));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tokenLabel, setTokenLabel] = useState("");
  const [newTokenSecret, setNewTokenSecret] = useState("");
  const [holdName, setHoldName] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [holdScope, setHoldScope] = useState<"organization" | "workspace" | "custodian" | "page">("organization");
  const [holdScopeIds, setHoldScopeIds] = useState("");
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [discoveryCustodians, setDiscoveryCustodians] = useState("");
  const [billingEmail, setBillingEmail] = useState(() => text(controls?.billingProfile?.billingEmail));
  const [planName, setPlanName] = useState(() => text(controls?.billingProfile?.planName));
  const [billingTitle, setBillingTitle] = useState("");
  const [billingAmount, setBillingAmount] = useState("");
  const organizationWorkspaces = useMemo(
    () => workspaces.filter((candidate) => candidate.organizationId === organization?.id),
    [organization?.id, workspaces],
  );
  const [mcpWorkspaceId, setMcpWorkspaceId] = useState("");
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpClientId, setMcpClientId] = useState("");
  const [mcpClientName, setMcpClientName] = useState("");
  const [mcpClientNames, setMcpClientNames] = useState<Record<string, string>>({});

  useEffect(() => {
    setSso(initialSso(controls?.ssoConfig));
    setScim(initialScim(controls?.scimConfig));
    setDlp(initialDlp(controls?.dlpPolicy));
    setResidency(initialResidency(controls?.dataResidencyPolicy));
    setRetentionDays(String(controls?.auditPolicy?.retentionDays ?? 365));
    setBillingEmail(text(controls?.billingProfile?.billingEmail));
    setPlanName(text(controls?.billingProfile?.planName));
  }, [controls]);

  useEffect(() => {
    const preferred = workspace && workspace.organizationId === organization?.id ? workspace.id : "";
    if (organizationWorkspaces.some((candidate) => candidate.id === mcpWorkspaceId)) return;
    setMcpWorkspaceId(preferred || organizationWorkspaces[0]?.id || "");
  }, [mcpWorkspaceId, organization?.id, organizationWorkspaces, workspace]);

  const mcpWorkspacePolicy = controls?.mcpGovernancePolicy?.workspacePolicies?.find(
    (policy) => policy.workspaceId === mcpWorkspaceId,
  );
  const approvedMcpClients = useMemo(
    () => mcpWorkspacePolicy?.approvedClients ?? [],
    [mcpWorkspacePolicy],
  );

  useEffect(() => {
    setMcpEnabled(mcpWorkspacePolicy?.enabled === true);
    setMcpClientNames(Object.fromEntries(
      approvedMcpClients.map((client) => [client.clientId, client.name]),
    ));
  }, [mcpWorkspacePolicy, approvedMcpClients]);

  const verifiedDomains = domains.filter((domain) => domain.status === "verified");
  const activeHolds = legalHolds.filter((hold) => (hold.status ?? "active") === "active");
  const endpoint = typeof window === "undefined"
    ? "/api/functions/scim/v2"
    : `${window.location.origin}/api/functions/scim/v2`;
  const statusCards = useMemo(() => [
    {
      label: t("enterpriseStatusSso"),
      ready: sso.enabled && Boolean(sso.issuer) && sso.enforcement !== "optional",
      detail: sso.enabled
        ? (sso.enforcement === "optional" ? t("enterpriseConfiguredNotEnforced") : t("enterpriseEnforced"))
        : t("enterpriseNotConfigured"),
    },
    {
      label: t("enterpriseStatusScim"),
      ready: scim.enabled && scimTokens.some((token) => (token.status ?? "active") === "active"),
      detail: scim.enabled ? t("enterpriseTokensActive", { count: scimTokens.filter((token) => token.status === "active").length }) : t("enterpriseNotConfigured"),
    },
    {
      label: t("enterpriseStatusDlp"),
      ready: dlp.enabled && dlp.contentScanMode === "block",
      detail: dlp.enabled ? t("enterpriseTermsActive", { count: splitLines(dlp.sensitiveTerms).length }) : t("enterpriseNotConfigured"),
    },
    {
      label: t("enterpriseStatusLegal"),
      ready: activeHolds.length > 0,
      detail: t("enterpriseHoldsActive", { count: activeHolds.length }),
    },
    {
      label: t("enterpriseStatusResidency"),
      ready: residency.enforcementMode === "strict",
      detail: residency.enforcementMode === "strict" ? t("enterpriseOperatorAttested") : t("enterpriseMetadataOnly"),
    },
  ], [activeHolds.length, dlp, residency.enforcementMode, scim.enabled, scimTokens, sso, t]);

  async function run(key: string, operation: () => Promise<void>) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  }

  async function saveControls(section: string, patch: Record<string, unknown>) {
    if (!organization?.id) return;
    await run(section, async () => {
      const result = await updateOrganizationEnterpriseControlsRemote({
        organizationId: organization.id,
        ...patch,
      });
      applyDirectory(result);
      setNotice(t("enterpriseSaved"));
      notify(t("enterpriseSaved"));
    });
  }

  function saveSso(event: FormEvent) {
    event.preventDefault();
    void saveControls("sso", {
      ssoConfig: {
        enabled: sso.enabled,
        providerType: "oidc",
        providerName: sso.providerName,
        issuer: sso.issuer,
        clientId: sso.clientId,
        enforcement: sso.enforcement,
        scopes: ["openid", "email", "profile"],
      },
    });
  }

  function saveScim(event: FormEvent) {
    event.preventDefault();
    void saveControls("scim", {
      scimConfig: {
        enabled: scim.enabled,
        provisioningMode: scim.enabled ? "scim_v2" : "manual",
        requireVerifiedDomain: scim.requireVerifiedDomain,
        deprovisionAction: "deactivate",
      },
    });
  }

  function saveDlp(event: FormEvent) {
    event.preventDefault();
    void saveControls("dlp", {
      dlpPolicy: {
        ...dlp,
        sensitiveTerms: splitLines(dlp.sensitiveTerms),
      },
    });
  }

  function saveAudit(event: FormEvent) {
    event.preventDefault();
    void saveControls("audit", {
      auditPolicy: { retentionDays: Number(retentionDays), exportFormat: "jsonl" },
    });
  }

  function saveResidency(event: FormEvent) {
    event.preventDefault();
    void saveControls("residency", {
      dataResidencyPolicy: {
        primaryRegion: residency.primaryRegion,
        allowedRegions: [residency.primaryRegion],
        enforcementMode: residency.enforcementMode,
      },
    });
  }

  function saveBilling(event: FormEvent) {
    event.preventDefault();
    void saveControls("billing", {
      billingProfile: {
        planName,
        billingEmail,
        contractStatus: "active",
      },
    });
  }

  function saveMcpGovernance(event: FormEvent) {
    event.preventDefault();
    if (!organization?.id || !mcpWorkspaceId) return;
    void run("mcp:policy", async () => {
      const result = await setOrganizationMcpGovernanceEnabledRemote({
        organizationId: organization.id,
        workspaceId: mcpWorkspaceId,
        enabled: mcpEnabled,
      });
      applyDirectory(result);
      setNotice(t("enterpriseMcpPolicySaved"));
      notify(t("enterpriseMcpPolicySaved"));
    });
  }

  function approveMcpClient(event: FormEvent) {
    event.preventDefault();
    if (!organization?.id || !mcpWorkspaceId) return;
    void run("mcp:approve", async () => {
      const result = await approveOrganizationMcpClientRemote({
        organizationId: organization.id,
        workspaceId: mcpWorkspaceId,
        clientId: mcpClientId.trim(),
        name: mcpClientName.trim() || mcpClientId.trim(),
      });
      applyDirectory(result);
      setMcpClientId("");
      setMcpClientName("");
      setNotice(t("enterpriseMcpClientApproved"));
    });
  }

  function renameMcpClient(client: OrganizationApprovedMcpClient) {
    if (!organization?.id || !mcpWorkspaceId) return;
    void run(`mcp:rename:${client.clientId}`, async () => {
      const result = await renameOrganizationMcpClientRemote({
        organizationId: organization.id!,
        workspaceId: mcpWorkspaceId,
        clientId: client.clientId,
        name: (mcpClientNames[client.clientId] ?? client.name).trim(),
      });
      applyDirectory(result);
      setNotice(t("enterpriseMcpClientRenamed"));
    });
  }

  function removeMcpClient(client: OrganizationApprovedMcpClient) {
    if (!organization?.id || !mcpWorkspaceId) return;
    void run(`mcp:remove:${client.clientId}`, async () => {
      const result = await removeOrganizationMcpClientRemote({
        organizationId: organization.id!,
        workspaceId: mcpWorkspaceId,
        clientId: client.clientId,
      });
      applyDirectory(result);
      setNotice(t("enterpriseMcpClientRemoved"));
    });
  }

  function createToken(event: FormEvent) {
    event.preventDefault();
    if (!organization?.id) return;
    void run("token:create", async () => {
      const result = await createOrganizationScimTokenRemote({
        organizationId: organization.id,
        label: tokenLabel || t("enterpriseDefaultTokenLabel"),
      });
      applyDirectory(result);
      setNewTokenSecret(result.scimTokenSecret ?? "");
      setTokenLabel("");
      setNotice(t("enterpriseTokenCreated"));
    });
  }

  function revokeToken(id: string) {
    if (!organization?.id) return;
    void run(`token:${id}`, async () => {
      const result = await revokeOrganizationScimTokenRemote({ organizationId: organization.id!, scimTokenId: id });
      applyDirectory(result);
      setNotice(t("enterpriseTokenRevoked"));
    });
  }

  function createHold(event: FormEvent) {
    event.preventDefault();
    if (!organization?.id) return;
    const ids = splitLines(holdScopeIds);
    const scope = holdScope === "organization" ? { all: true }
      : holdScope === "workspace" ? { workspaceIds: ids }
        : holdScope === "page" ? { pageIds: ids }
          : { userIds: ids };
    void run("hold:create", async () => {
      const result = await createOrganizationLegalHoldRemote({
        organizationId: organization.id!,
        name: holdName,
        reason: holdReason,
        scope,
      });
      applyDirectory(result);
      setHoldName("");
      setHoldReason("");
      setHoldScopeIds("");
      setNotice(t("enterpriseHoldCreated"));
    });
  }

  function releaseHold(hold: OrganizationLegalHold) {
    if (!organization?.id) return;
    void run(`hold:${hold.id}`, async () => {
      const result = await releaseOrganizationLegalHoldRemote({
        organizationId: organization.id!,
        legalHoldId: hold.id,
      });
      applyDirectory(result);
      setNotice(t("enterpriseHoldReleased"));
    });
  }

  function exportAudit() {
    if (!organization?.id) return;
    void run("audit:export", async () => {
      const result = await exportOrganizationAuditEventsRemote({
        organizationId: organization.id!,
        format: "jsonl",
        auditLimit: 5_000,
      });
      applyDirectory(result);
      const content = result.auditExportContent ?? result.auditExport?.content;
      if (content) downloadText(`hanji-audit-${Date.now()}.jsonl`, content, "application/x-ndjson");
      setNotice(t("enterpriseAuditExported", { count: result.auditExport?.eventCount ?? 0 }));
    });
  }

  function exportDiscovery(event: FormEvent) {
    event.preventDefault();
    if (!organization?.id) return;
    void run("discovery", async () => {
      const result = await exportOrganizationDiscoveryRemote({
        organizationId: organization.id!,
        query: discoveryQuery || null,
        userIds: splitLines(discoveryCustodians),
        includeTrashed: true,
        format: "jsonl",
      });
      applyDirectory(result);
      const content = result.discoveryExport?.content;
      if (content) downloadText(`hanji-discovery-${Date.now()}.jsonl`, content, "application/x-ndjson");
      setNotice(t("enterpriseDiscoveryExported", { count: result.discoveryExport?.itemCount ?? 0 }));
    });
  }

  function addBillingRecord(event: FormEvent) {
    event.preventDefault();
    if (!organization?.id) return;
    void run("billing:record", async () => {
      const result = await upsertOrganizationBillingRecordRemote({
        organizationId: organization.id!,
        title: billingTitle,
        kind: "contract",
        status: "active",
        amountCents: billingAmount ? Math.round(Number(billingAmount) * 100) : null,
        currency: "USD",
        billingEmail: billingEmail || null,
      });
      applyDirectory(result);
      setBillingTitle("");
      setBillingAmount("");
    });
  }

  function deleteBillingRecord(record: OrganizationBillingRecord) {
    if (!organization?.id) return;
    void run(`billing:${record.id}`, async () => {
      const result = await deleteOrganizationBillingRecordRemote({
        organizationId: organization.id!,
        billingRecordId: record.id,
      });
      applyDirectory(result);
    });
  }

  if (!organization?.id) {
    return <section className={styles.section}><div className={styles.emptyState}>{t("enterpriseOrganizationRequired")}</div></section>;
  }

  return (
    <section id="enterprise" className={`${styles.section} ${styles.enterprisePanel}`}>
      <div className={styles.sectionHeader}>
        <div>
          <div className={styles.sectionTitle}>{t("enterpriseTitle")}</div>
          <p className={styles.sectionSubtitle}>{t("enterpriseSubtitle")}</p>
        </div>
      </div>

      <div className={styles.enterpriseStatusGrid} aria-label={t("enterpriseReadiness")}>
        {statusCards.map((card) => (
          <div className={styles.enterpriseStatusCard} key={card.label} data-ready={card.ready ? "true" : "false"}>
            <span>{card.label}</span>
            <strong>{card.detail}</strong>
          </div>
        ))}
      </div>

      {error ? <div className={styles.notice}>{error}</div> : null}
      {notice ? <div className={styles.notice} data-tone="neutral">{notice}</div> : null}

      <div className={styles.enterpriseSections}>
        <details className={styles.enterpriseSection} open>
          <summary><span>{t("enterpriseSsoTitle")}</span><strong>{sso.enabled ? t("enterpriseOn") : t("enterpriseOff")}</strong></summary>
          <form className={styles.enterpriseForm} onSubmit={saveSso}>
            <p>{t("enterpriseSsoDescription")}</p>
            <label className={styles.enterpriseCheck}><input type="checkbox" checked={sso.enabled} disabled={!canManageSecurity} onChange={(event) => setSso({ ...sso, enabled: event.target.checked })} />{t("enterpriseEnableSso")}</label>
            <label><span>{t("enterpriseProvider")}</span><select value="oidc" disabled><option value="oidc">OIDC</option><option value="saml">SAML</option></select></label>
            <label><span>{t("enterpriseProviderName")}</span><input value={sso.providerName} disabled={!canManageSecurity} onChange={(event) => setSso({ ...sso, providerName: event.target.value })} /></label>
            <label><span>{t("enterpriseIssuer")}</span><input type="url" placeholder="https://id.example.com" value={sso.issuer} disabled={!canManageSecurity} onChange={(event) => setSso({ ...sso, issuer: event.target.value })} /></label>
            <label><span>{t("enterpriseClientId")}</span><input value={sso.clientId} disabled={!canManageSecurity} onChange={(event) => setSso({ ...sso, clientId: event.target.value })} /></label>
            <label><span>{t("enterpriseEnforcement")}</span><select value={sso.enforcement} disabled={!canManageSecurity} onChange={(event) => setSso({ ...sso, enforcement: event.target.value as SsoDraft["enforcement"] })}><option value="optional">{t("enterpriseOptional")}</option><option value="required_for_verified_domains">{t("enterpriseVerifiedDomains")}</option><option value="required_for_all_members">{t("enterpriseAllMembers")}</option></select></label>
            <div className={styles.enterpriseCallout}>{t("enterpriseSsoEnvHelp")}</div>
            {canManageSecurity ? <button className={styles.primaryButton} disabled={busy === "sso"}>{t("enterpriseSaveSso")}</button> : null}
          </form>
        </details>

        <details className={styles.enterpriseSection} open>
          <summary><span>{t("enterpriseScimTitle")}</span><strong>{scimTokens.filter((token) => token.status === "active").length}</strong></summary>
          <form className={styles.enterpriseForm} onSubmit={saveScim}>
            <p>{t("enterpriseScimDescription")}</p>
            <label className={styles.enterpriseCheck}><input type="checkbox" checked={scim.enabled} disabled={!canManageSecurity} onChange={(event) => setScim({ ...scim, enabled: event.target.checked })} />{t("enterpriseEnableScim")}</label>
            <label className={styles.enterpriseCheck}><input type="checkbox" checked={scim.requireVerifiedDomain} disabled={!canManageSecurity} onChange={(event) => setScim({ ...scim, requireVerifiedDomain: event.target.checked })} />{t("enterpriseRequireVerifiedDomain")}</label>
            <label><span>{t("enterpriseScimEndpoint")}</span><input value={endpoint} readOnly /></label>
            {canManageSecurity ? <button className={styles.secondaryButton} disabled={busy === "scim"}>{t("enterpriseSaveScim")}</button> : null}
          </form>
          {newTokenSecret ? <div className={styles.enterpriseSecret}><strong>{t("enterpriseCopyTokenNow")}</strong><code>{newTokenSecret}</code><button type="button" className={styles.secondaryButton} onClick={() => void navigator.clipboard.writeText(newTokenSecret)}>{t("enterpriseCopy")}</button></div> : null}
          {canManageSecurity ? <form className={styles.enterpriseInlineForm} onSubmit={createToken}><input aria-label={t("enterpriseTokenLabel")} placeholder={t("enterpriseTokenLabel")} value={tokenLabel} onChange={(event) => setTokenLabel(event.target.value)} /><button className={styles.primaryButton} disabled={busy === "token:create" || !scim.enabled}>{t("enterpriseCreateToken")}</button></form> : null}
          <div className={styles.enterpriseList}>{scimTokens.map((token) => <div key={token.id}><span><strong>{token.label}</strong><small>{token.tokenPrefix ?? ""} · {token.lastUsedAt ? t("enterpriseLastUsed", { date: new Date(token.lastUsedAt).toLocaleString(i18n.resolvedLanguage || i18n.language || "en") }) : t("enterpriseNeverUsed")}</small></span>{canManageSecurity && token.status === "active" ? <button type="button" className={styles.secondaryButton} disabled={busy === `token:${token.id}`} onClick={() => revokeToken(token.id)}>{t("enterpriseRevoke")}</button> : <em>{token.status}</em>}</div>)}</div>
        </details>

        <details className={styles.enterpriseSection}>
          <summary>
            <span>{t("enterpriseMcpTitle")}</span>
            <strong>{mcpWorkspacePolicy?.enabled ? t("enterpriseOn") : t("enterpriseOff")}</strong>
          </summary>
          <form className={styles.enterpriseForm} onSubmit={saveMcpGovernance}>
            <p>{t("enterpriseMcpDescription")}</p>
            <label>
              <span>{t("enterpriseMcpWorkspace")}</span>
              <select
                value={mcpWorkspaceId}
                disabled={organizationWorkspaces.length === 0}
                onChange={(event) => setMcpWorkspaceId(event.target.value)}
              >
                {organizationWorkspaces.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                ))}
              </select>
            </label>
            <label className={styles.enterpriseCheck}>
              <input
                type="checkbox"
                checked={mcpEnabled}
                disabled={!canManageSecurity || !mcpWorkspaceId}
                onChange={(event) => setMcpEnabled(event.target.checked)}
              />
              {t("enterpriseMcpEnable")}
            </label>
            <div className={styles.enterpriseCallout}>{t("enterpriseMcpScopeHelp")}</div>
            {mcpEnabled && approvedMcpClients.length === 0
              ? <div className={styles.enterpriseCallout}>{t("enterpriseMcpBlockAllWarning")}</div>
              : null}
            {!canManageSecurity
              ? <div className={styles.enterpriseCallout}>{t("enterpriseMcpSecurityRoleRequired")}</div>
              : null}
            {canManageSecurity ? (
              <button className={styles.primaryButton} disabled={busy === "mcp:policy" || !mcpWorkspaceId}>
                {t("enterpriseMcpSavePolicy")}
              </button>
            ) : null}
          </form>
          {canManageSecurity ? (
            <form className={styles.enterpriseInlineForm} onSubmit={approveMcpClient}>
              <input
                required
                aria-label={t("enterpriseMcpClientId")}
                placeholder={t("enterpriseMcpClientIdPlaceholder")}
                value={mcpClientId}
                onChange={(event) => setMcpClientId(event.target.value)}
              />
              <input
                required
                aria-label={t("enterpriseMcpClientName")}
                placeholder={t("enterpriseMcpClientName")}
                value={mcpClientName}
                onChange={(event) => setMcpClientName(event.target.value)}
              />
              <button className={styles.primaryButton} disabled={busy === "mcp:approve" || !mcpWorkspaceId}>
                {t("enterpriseMcpApprove")}
              </button>
            </form>
          ) : null}
          <div className={styles.enterpriseList}>
            {approvedMcpClients.map((client) => (
              <div key={client.clientId}>
                <span>
                  <strong>{client.name}</strong>
                  <small>{client.clientId}</small>
                </span>
                {canManageSecurity ? (
                  <div className={styles.enterpriseClientActions}>
                    <input
                      aria-label={t("enterpriseMcpRenameLabel", { name: client.name })}
                      value={mcpClientNames[client.clientId] ?? client.name}
                      onChange={(event) => setMcpClientNames({
                        ...mcpClientNames,
                        [client.clientId]: event.target.value,
                      })}
                    />
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busy === `mcp:rename:${client.clientId}`}
                      onClick={() => renameMcpClient(client)}
                    >
                      {t("enterpriseRename")}
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busy === `mcp:remove:${client.clientId}`}
                      onClick={() => removeMcpClient(client)}
                    >
                      {t("enterpriseRemove")}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <small>{t("enterpriseMcpApprovedCount", { count: approvedMcpClients.length })}</small>
        </details>

        <NotionAdminApiPanel
          organizationId={organization.id!}
          canManageSecurity={canManageSecurity}
        />

        <details className={styles.enterpriseSection}>
          <summary><span>{t("enterpriseDlpTitle")}</span><strong>{splitLines(dlp.sensitiveTerms).length}</strong></summary>
          <form className={styles.enterpriseForm} onSubmit={saveDlp}>
            <p>{t("enterpriseDlpDescription")}</p>
            <label className={styles.enterpriseCheck}><input type="checkbox" checked={dlp.enabled} disabled={!canManageSecurity} onChange={(event) => setDlp({ ...dlp, enabled: event.target.checked })} />{t("enterpriseEnableDlp")}</label>
            <label><span>{t("enterpriseContentMode")}</span><select value={dlp.contentScanMode} disabled={!canManageSecurity} onChange={(event) => setDlp({ ...dlp, contentScanMode: event.target.value as DlpDraft["contentScanMode"] })}><option value="block">{t("enterpriseBlock")}</option><option value="off">{t("enterpriseOff")}</option></select></label>
            <label><span>{t("enterpriseSensitiveTerms")}</span><textarea rows={5} value={dlp.sensitiveTerms} disabled={!canManageSecurity} placeholder={t("enterpriseSensitiveTermsHelp")} onChange={(event) => setDlp({ ...dlp, sensitiveTerms: event.target.value })} /></label>
            <div className={styles.enterpriseChecks}>{(["blockPublicSharing", "blockExternalSharing", "blockFileDownloads", "blockExports"] as const).map((key) => <label className={styles.enterpriseCheck} key={key}><input type="checkbox" checked={dlp[key]} disabled={!canManageSecurity} onChange={(event) => setDlp({ ...dlp, [key]: event.target.checked })} />{t(`enterprise_${key}`)}</label>)}</div>
            {canManageSecurity ? <button className={styles.primaryButton} disabled={busy === "dlp"}>{t("enterpriseSaveDlp")}</button> : null}
          </form>
        </details>

        <details className={styles.enterpriseSection}>
          <summary><span>{t("enterpriseAuditTitle")}</span><strong>{auditExports.length}</strong></summary>
          <form className={styles.enterpriseInlineForm} onSubmit={saveAudit}><label><span>{t("enterpriseRetentionDays")}</span><input type="number" min={30} max={3650} value={retentionDays} disabled={!canManageSecurity} onChange={(event) => setRetentionDays(event.target.value)} /></label>{canManageSecurity ? <button className={styles.secondaryButton} disabled={busy === "audit"}>{t("enterpriseSave")}</button> : null}<button type="button" className={styles.primaryButton} disabled={busy === "audit:export"} onClick={exportAudit}>{t("enterpriseExportAudit")}</button></form>
          <form className={styles.enterpriseForm} onSubmit={exportDiscovery}>
            <h4>{t("enterpriseDiscoveryTitle")}</h4><p>{t("enterpriseDiscoveryDescription")}</p>
            <label><span>{t("enterpriseSearchTerms")}</span><input value={discoveryQuery} onChange={(event) => setDiscoveryQuery(event.target.value)} /></label>
            <label><span>{t("enterpriseCustodianIds")}</span><textarea rows={3} value={discoveryCustodians} placeholder={members.slice(0, 2).map((member) => member.userId).join("\n")} onChange={(event) => setDiscoveryCustodians(event.target.value)} /></label>
            {canManageSecurity ? <button className={styles.primaryButton} disabled={busy === "discovery"}>{t("enterpriseExportDiscovery")}</button> : null}
          </form>
          <small>{t("enterpriseExportHistory", { audit: auditExports.length, discovery: discoveryExports.length })}</small>
        </details>

        <details className={styles.enterpriseSection}>
          <summary><span>{t("enterpriseLegalTitle")}</span><strong>{activeHolds.length}</strong></summary>
          {canManageSecurity ? <form className={styles.enterpriseForm} onSubmit={createHold}><label><span>{t("enterpriseHoldName")}</span><input required value={holdName} onChange={(event) => setHoldName(event.target.value)} /></label><label><span>{t("enterpriseReason")}</span><textarea required rows={3} value={holdReason} onChange={(event) => setHoldReason(event.target.value)} /></label><label><span>{t("enterpriseScope")}</span><select value={holdScope} onChange={(event) => setHoldScope(event.target.value as typeof holdScope)}><option value="organization">{t("enterpriseEntireOrganization")}</option><option value="workspace">{t("enterpriseWorkspaces")}</option><option value="custodian">{t("enterpriseCustodians")}</option><option value="page">{t("enterprisePages")}</option></select></label>{holdScope !== "organization" ? <label><span>{t("enterpriseScopeIds")}</span><textarea required rows={3} value={holdScopeIds} placeholder={holdScope === "workspace" ? workspaces.slice(0, 2).map((workspace) => workspace.id).join("\n") : "id-1\nid-2"} onChange={(event) => setHoldScopeIds(event.target.value)} /></label> : null}<button className={styles.primaryButton} disabled={busy === "hold:create"}>{t("enterpriseCreateHold")}</button></form> : null}
          <div className={styles.enterpriseList}>{legalHolds.map((hold) => <div key={hold.id}><span><strong>{hold.name}</strong><small>{hold.reason} · {hold.status}</small></span>{canManageSecurity && hold.status === "active" ? <button type="button" className={styles.secondaryButton} disabled={busy === `hold:${hold.id}`} onClick={() => releaseHold(hold)}>{t("enterpriseRelease")}</button> : null}</div>)}</div>
        </details>

        <details className={styles.enterpriseSection}>
          <summary><span>{t("enterpriseResidencyTitle")}</span><strong>{residency.primaryRegion.toUpperCase()}</strong></summary>
          <form className={styles.enterpriseForm} onSubmit={saveResidency}><p>{t("enterpriseResidencyDescription")}</p><label><span>{t("enterprisePrimaryRegion")}</span><select value={residency.primaryRegion} disabled={!canManageSecurity} onChange={(event) => setResidency({ ...residency, primaryRegion: event.target.value as ResidencyDraft["primaryRegion"] })}><option value="global">Global</option><option value="us">US</option><option value="eu">EU</option><option value="kr">KR</option><option value="apac">APAC</option></select></label><label><span>{t("enterpriseResidencyMode")}</span><select value={residency.enforcementMode} disabled={!canManageSecurity} onChange={(event) => setResidency({ ...residency, enforcementMode: event.target.value as ResidencyDraft["enforcementMode"] })}><option value="metadata_only">{t("enterpriseMetadataOnly")}</option><option value="strict">{t("enterpriseStrict")}</option></select></label><div className={styles.enterpriseCallout}>{t("enterpriseResidencyEnvHelp")}</div>{canManageSecurity ? <button className={styles.primaryButton} disabled={busy === "residency"}>{t("enterpriseSaveResidency")}</button> : null}</form>
        </details>

        <details className={styles.enterpriseSection}>
          <summary><span>{t("enterpriseBillingTitle")}</span><strong>{billingRecords.length}</strong></summary>
          <form className={styles.enterpriseForm} onSubmit={saveBilling}><label><span>{t("enterprisePlanName")}</span><input value={planName} disabled={!canManageBilling} onChange={(event) => setPlanName(event.target.value)} /></label><label><span>{t("enterpriseBillingEmail")}</span><input type="email" value={billingEmail} disabled={!canManageBilling} onChange={(event) => setBillingEmail(event.target.value)} /></label><div className={styles.enterpriseCallout}>{t("enterpriseBillingWebhookHelp", { endpoint: typeof window === "undefined" ? "/api/functions/billing/webhook" : `${window.location.origin}/api/functions/billing/webhook` })}</div>{canManageBilling ? <button className={styles.secondaryButton} disabled={busy === "billing"}>{t("enterpriseSaveBilling")}</button> : null}</form>
          {canManageBilling ? <form className={styles.enterpriseInlineForm} onSubmit={addBillingRecord}><input required placeholder={t("enterpriseContractTitle")} value={billingTitle} onChange={(event) => setBillingTitle(event.target.value)} /><input inputMode="decimal" placeholder={t("enterpriseAmountUsd")} value={billingAmount} onChange={(event) => setBillingAmount(event.target.value)} /><button className={styles.primaryButton} disabled={busy === "billing:record"}>{t("enterpriseAddRecord")}</button></form> : null}
          <div className={styles.enterpriseList}>{billingRecords.map((record) => <div key={record.id}><span><strong>{record.title}</strong><small>{record.status} · {record.amountCents != null ? `${record.currency ?? "USD"} ${(record.amountCents / 100).toFixed(2)}` : t("enterpriseNoAmount")}</small></span>{canManageBilling ? <button type="button" className={styles.secondaryButton} disabled={busy === `billing:${record.id}`} onClick={() => deleteBillingRecord(record)}>{t("enterpriseDelete")}</button> : null}</div>)}</div>
        </details>
      </div>

      <div className={styles.enterpriseFootnote}>{t("enterpriseVerifiedDomainCount", { count: verifiedDomains.length })}</div>
    </section>
  );
}
