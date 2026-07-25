"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createOrganizationAdminTokenRemote,
  listOrganizationAdminTokensRemote,
  revokeOrganizationAdminTokenRemote,
} from "@/lib/edgebase";
import type {
  NotionAdminCapability,
  OrganizationAdminToken,
} from "@/lib/types";
import styles from "./WorkspaceSettingsDialog.module.css";

const CAPABILITIES: NotionAdminCapability[] = [
  "legal-hold:read",
  "legal-hold:write",
  "legal-hold:write-high-impact",
  "legal-hold:export",
  "workspace:export",
  "managed-user-session:write",
];

type NotionAdminApiPanelProps = {
  organizationId: string;
  canManageSecurity: boolean;
};

function resourceIds(value: string) {
  const ids = Array.from(new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)));
  return ids.length ? ids : ["*"];
}

export function NotionAdminApiPanel({
  organizationId,
  canManageSecurity,
}: NotionAdminApiPanelProps) {
  const { t, i18n } = useTranslation("workspaceSettingsDialog");
  const [tokens, setTokens] = useState<OrganizationAdminToken[]>([]);
  const [label, setLabel] = useState("");
  const [capabilities, setCapabilities] = useState<NotionAdminCapability[]>(CAPABILITIES);
  const [workspaceIds, setWorkspaceIds] = useState("*");
  const [legalHoldIds, setLegalHoldIds] = useState("*");
  const [expiresAt, setExpiresAt] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const activeCount = useMemo(
    () => tokens.filter((token) => (token.status ?? "active") === "active").length,
    [tokens],
  );
  const baseUrl = typeof window === "undefined"
    ? "/api/functions/admin"
    : `${window.location.origin}/api/functions/admin`;

  useEffect(() => {
    if (!organizationId || !canManageSecurity) return;
    let cancelled = false;
    setBusy("list");
    listOrganizationAdminTokensRemote(organizationId)
      .then((next) => {
        if (!cancelled) setTokens(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : t("enterpriseAdminApiLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setBusy("");
      });
    return () => {
      cancelled = true;
    };
  }, [canManageSecurity, organizationId, t]);

  function toggleCapability(capability: NotionAdminCapability) {
    setCapabilities((current) => current.includes(capability)
      ? current.filter((entry) => entry !== capability)
      : [...current, capability]);
  }

  function createToken(event: FormEvent) {
    event.preventDefault();
    if (!canManageSecurity || !label.trim() || capabilities.length === 0) return;
    setBusy("create");
    setMessage("");
    createOrganizationAdminTokenRemote({
      organizationId,
      label: label.trim(),
      capabilities,
      workspaceIds: resourceIds(workspaceIds),
      legalHoldIds: resourceIds(legalHoldIds),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    })
      .then((result) => {
        if (result.adminToken) setTokens((current) => [result.adminToken!, ...current]);
        setSecret(result.adminTokenSecret ?? "");
        setLabel("");
        setMessage(t("enterpriseAdminApiTokenCreated"));
      })
      .catch((error: unknown) => setMessage(
        error instanceof Error ? error.message : t("enterpriseAdminApiCreateFailed"),
      ))
      .finally(() => setBusy(""));
  }

  function revokeToken(token: OrganizationAdminToken) {
    setBusy(`revoke:${token.id}`);
    setMessage("");
    revokeOrganizationAdminTokenRemote({ organizationId, tokenId: token.id })
      .then((result) => {
        if (result.adminToken) {
          setTokens((current) => current.map((entry) =>
            entry.id === result.adminToken!.id ? result.adminToken! : entry));
        }
        setMessage(t("enterpriseAdminApiTokenRevoked"));
      })
      .catch((error: unknown) => setMessage(
        error instanceof Error ? error.message : t("enterpriseAdminApiRevokeFailed"),
      ))
      .finally(() => setBusy(""));
  }

  return (
    <details className={styles.enterpriseSection}>
      <summary>
        <span>{t("enterpriseAdminApiTitle")}</span>
        <strong>{activeCount}</strong>
      </summary>
      <div className={styles.enterpriseForm}>
        <p>{t("enterpriseAdminApiDescription")}</p>
        <label>
          <span>{t("enterpriseAdminApiBaseUrl")}</span>
          <input value={baseUrl} readOnly />
        </label>
        <label>
          <span>{t("enterpriseAdminApiVersion")}</span>
          <input value="2026-06-01" readOnly />
        </label>
        <div className={styles.enterpriseCallout}>{t("enterpriseAdminApiScopeHelp")}</div>
        {!canManageSecurity
          ? <div className={styles.enterpriseCallout}>{t("enterpriseAdminApiSecurityRoleRequired")}</div>
          : null}
      </div>

      {canManageSecurity ? (
        <form className={styles.enterpriseForm} onSubmit={createToken}>
          <label>
            <span>{t("enterpriseAdminApiTokenLabel")}</span>
            <input
              required
              value={label}
              placeholder={t("enterpriseAdminApiTokenLabelPlaceholder")}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <div className={styles.enterpriseChecks} aria-label={t("enterpriseAdminApiCapabilities")}>
            {CAPABILITIES.map((capability) => (
              <label className={styles.enterpriseCheck} key={capability}>
                <input
                  type="checkbox"
                  checked={capabilities.includes(capability)}
                  onChange={() => toggleCapability(capability)}
                />
                {capability}
              </label>
            ))}
          </div>
          <label>
            <span>{t("enterpriseAdminApiWorkspaceIds")}</span>
            <textarea rows={3} value={workspaceIds} onChange={(event) => setWorkspaceIds(event.target.value)} />
          </label>
          <label>
            <span>{t("enterpriseAdminApiLegalHoldIds")}</span>
            <textarea rows={3} value={legalHoldIds} onChange={(event) => setLegalHoldIds(event.target.value)} />
          </label>
          <label>
            <span>{t("enterpriseAdminApiExpiresAt")}</span>
            <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </label>
          <button
            className={styles.primaryButton}
            disabled={busy === "create" || capabilities.length === 0}
          >
            {t("enterpriseAdminApiCreateToken")}
          </button>
        </form>
      ) : null}

      {secret ? (
        <div className={styles.enterpriseSecret}>
          <strong>{t("enterpriseAdminApiCopyNow")}</strong>
          <code>{secret}</code>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void navigator.clipboard.writeText(secret)}
          >
            {t("enterpriseCopy")}
          </button>
        </div>
      ) : null}

      {message ? <div className={styles.enterpriseCallout} role="status">{message}</div> : null}
      <div className={styles.enterpriseList} aria-busy={busy === "list"}>
        {tokens.map((token) => {
          const tokenCapabilities = token.scopes?.capabilities ?? [];
          const lastUsed = token.lastUsedAt
            ? new Date(token.lastUsedAt).toLocaleString(i18n.resolvedLanguage || i18n.language || "en")
            : t("enterpriseNeverUsed");
          return (
            <div key={token.id}>
              <span>
                <strong>{token.label}</strong>
                <small>{token.tokenPrefix ?? ""} · {tokenCapabilities.join(", ")} · {lastUsed}</small>
              </span>
              {canManageSecurity && (token.status ?? "active") === "active" ? (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy === `revoke:${token.id}`}
                  onClick={() => revokeToken(token)}
                >
                  {t("enterpriseRevoke")}
                </button>
              ) : <em>{token.status}</em>}
            </div>
          );
        })}
      </div>
    </details>
  );
}
