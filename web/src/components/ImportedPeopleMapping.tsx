"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  applyPersonMappingsRemote,
  listImportedPeopleRemote,
  type ImportedPeopleResult,
} from "@/lib/edgebase";
import styles from "./WorkspaceSettingsDialog.module.css";

export function ImportedPeopleMapping({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation(["importedPeopleMapping", "common"]);
  const [result, setResult] = useState<ImportedPeopleResult | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"scan" | "apply" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setBusy("scan");
    setError(null);
    setNotice(null);
    try {
      const next = await listImportedPeopleRemote(workspaceId);
      setResult(next);
      const suggested: Record<string, string> = {};
      for (const person of next.people) {
        if (person.suggestedUserId) suggested[person.sourceId] = person.suggestedUserId;
      }
      setSelection(suggested);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("importedPeopleMapping:failed"));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    const mappings = Object.fromEntries(
      Object.entries(selection).filter(([, userId]) => Boolean(userId)),
    );
    if (!Object.keys(mappings).length) return;
    setBusy("apply");
    setError(null);
    setNotice(null);
    try {
      const summary = await applyPersonMappingsRemote(workspaceId, mappings);
      setNotice(
        t("importedPeopleMapping:applied", {
          people: summary.mappedPeople,
          pages: summary.changedPages,
          blocks: summary.changedBlocks,
        }),
      );
      await listImportedPeopleRemote(workspaceId).then((next) => {
        setResult(next);
        setSelection({});
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("importedPeopleMapping:failed"));
    } finally {
      setBusy(null);
    }
  }

  const people = result?.people ?? [];
  const members = result?.members ?? [];
  const selectable = Object.values(selection).some(Boolean);

  return (
    <div className={styles.subsection} data-testid="imported-people-mapping">
      <div className={styles.sectionHeader}>
        <div>
          <div className={styles.subsectionTitle}>{t("importedPeopleMapping:title")}</div>
          <div className={styles.organizationMeta}>{t("importedPeopleMapping:body")}</div>
        </div>
        <div className={styles.sectionActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy !== null}
            onClick={() => void scan()}
          >
            {busy === "scan"
              ? t("importedPeopleMapping:scanning")
              : result
                ? t("importedPeopleMapping:rescan")
                : t("importedPeopleMapping:scan")}
          </button>
        </div>
      </div>
      {error ? <div className={styles.notice}>{error}</div> : null}
      {notice ? (
        <div className={styles.notice} data-tone="neutral">
          {notice}
        </div>
      ) : null}
      {result && people.length === 0 ? (
        <div className={styles.notice} data-tone="neutral">
          {t("importedPeopleMapping:empty")}
        </div>
      ) : null}
      {people.length > 0 ? (
        <div className={styles.memberList} aria-busy={busy !== null}>
          {people.map((person) => {
            const label = person.displayName || person.email || person.sourceId;
            return (
              <div key={person.sourceId} className={styles.memberRow}>
                <span className={styles.memberAvatar} aria-hidden="true">
                  {(label.trim().slice(0, 1) || "?").toUpperCase()}
                </span>
                <span className={styles.memberText}>
                  <strong>{label}</strong>
                  <span>
                    {person.email ? `${person.email} · ` : ""}
                    {t("importedPeopleMapping:usage", {
                      values: person.propertyValueCount,
                      mentions: person.mentionCount,
                    })}
                  </span>
                </span>
                <span className={styles.memberControls}>
                  <select
                    className={styles.memberSelect}
                    aria-label={t("importedPeopleMapping:mapAria", { label })}
                    value={selection[person.sourceId] ?? ""}
                    disabled={busy !== null}
                    onChange={(event) =>
                      setSelection((current) => ({
                        ...current,
                        [person.sourceId]: event.target.value,
                      }))
                    }
                  >
                    <option value="">{t("importedPeopleMapping:keepPlaceholder")}</option>
                    {members.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {(member.displayName || member.email || member.userId) +
                          (person.suggestedUserId === member.userId
                            ? ` (${t("importedPeopleMapping:suggested")})`
                            : "")}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {people.length > 0 ? (
        <div className={styles.sectionActions}>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy !== null || !selectable}
            onClick={() => void apply()}
          >
            {busy === "apply"
              ? t("importedPeopleMapping:applying")
              : t("importedPeopleMapping:apply")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
