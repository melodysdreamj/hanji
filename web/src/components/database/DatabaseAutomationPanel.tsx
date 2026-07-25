"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteDatabaseAutomationRemote,
  listDatabaseAutomationsRemote,
  resumeDatabaseAutomationRemote,
  saveDatabaseAutomationRemote,
  setDatabaseAutomationEnabledRemote,
} from "@/lib/edgebase";
import { newId } from "@/lib/ids";
import { useStore } from "@/lib/store";
import type { AutomationAction, DatabaseAutomationDefinition, DbProperty, DbView } from "@/lib/types";
import { Plus, Trash, X } from "@/icons/hanji";
import {
  AutomationActionEditor,
  automationDocumentActions,
  automationEditorActionsValid,
  newAutomationEditorAction,
} from "../automation/AutomationActionEditor";
import styles from "./database.module.css";

const EDITABLE_TYPES = new Set([
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "person",
  "checkbox",
  "url",
  "email",
  "phone",
  "place",
  "verification",
]);

function storedDefinition(
  automation: DatabaseAutomationDefinition,
  name: string,
  actions: AutomationAction[],
) {
  return {
    name,
    enabled: automation.enabled,
    scope: automation.scopeType === "view" && automation.viewId
      ? { type: "view", viewId: automation.viewId }
      : { type: "database" },
    trigger: structuredClone(automation.trigger),
    actionDocument: {
      ...structuredClone(automation.actionDocument),
      label: name,
      actions: structuredClone(actions),
    },
  };
}

export function DatabaseAutomationPanel({
  databaseId,
  workspaceId,
  properties,
  views,
  onClose,
}: {
  databaseId: string;
  workspaceId: string;
  properties: DbProperty[];
  views: DbView[];
  onClose: () => void;
}) {
  const { t } = useTranslation(["databaseView", "common"]);
  const [automations, setAutomations] = useState<DatabaseAutomationDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<DatabaseAutomationDefinition | "new" | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftActions, setDraftActions] = useState<AutomationAction[]>([]);
  const editorPagesById = useStore((state) => state.pagesById);
  const editorPages = useMemo(() => Object.values(editorPagesById), [editorPagesById]);
  const editableProperties = useMemo(
    () => properties.filter((property) => EDITABLE_TYPES.has(property.type)),
    [properties],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void listDatabaseAutomationsRemote({ workspaceId, databaseId })
      .then((result) => {
        if (!active) return;
        setAutomations(result.automations);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : t("databaseView:automationLoadFailed"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [databaseId, t, workspaceId]);

  function beginCreate() {
    setEditing("new");
    setDraftName(t("databaseView:newAutomation"));
    setDraftActions(editableProperties[0]
      ? [newAutomationEditorAction("edit_property", {
          properties: editableProperties,
          pages: editorPages,
          views,
        })]
      : []);
    setError("");
  }

  function beginEdit(automation: DatabaseAutomationDefinition) {
    setEditing(automation);
    setDraftName(automation.name);
    setDraftActions(automationDocumentActions(automation.actionDocument));
    setError("");
  }

  async function saveDraft() {
    const name = draftName.trim();
    if (!editing || !name) return;
    const surface = editing !== "new" && editing.triggerType === "schedule"
      ? "schedule_automation"
      : "event_automation";
    if (!automationEditorActionsValid(draftActions, surface)) return;
    const id = editing === "new" ? newId() : editing.id;
    setBusyId(id);
    setError("");
    try {
      const definition = editing === "new"
        ? {
            name,
            enabled: true,
            scope: { type: "database" },
            trigger: { type: "events", mode: "any", conditions: [{ type: "row_added" }] },
            actionDocument: {
              version: 1,
              label: name,
              actions: structuredClone(draftActions),
            },
          }
        : storedDefinition(editing, name, draftActions);
      const result = await saveDatabaseAutomationRemote({
        workspaceId,
        databaseId,
        automationId: id,
        ...(editing === "new" ? {} : { expectedRevision: editing.revision }),
        definition,
      });
      setAutomations((current) => (
        [...current.filter((automation) => automation.id !== result.automation.id), result.automation]
          .sort((left, right) => left.id.localeCompare(right.id))
      ));
      setEditing(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("databaseView:automationSaveFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleAutomation(automation: DatabaseAutomationDefinition) {
    setBusyId(automation.id);
    setError("");
    try {
      const result = automation.status === "paused"
        ? await resumeDatabaseAutomationRemote({
            workspaceId,
            databaseId,
            automationId: automation.id,
            expectedRevision: automation.revision,
          })
        : await setDatabaseAutomationEnabledRemote({
            workspaceId,
            databaseId,
            automationId: automation.id,
            expectedRevision: automation.revision,
            enabled: !automation.enabled,
          });
      setAutomations((current) => current.map((item) => (
        item.id === automation.id ? result.automation : item
      )));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("databaseView:automationSaveFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteAutomation(automation: DatabaseAutomationDefinition) {
    if (!globalThis.confirm(t("databaseView:confirmDeleteAutomation", { name: automation.name }))) return;
    setBusyId(automation.id);
    setError("");
    try {
      await deleteDatabaseAutomationRemote({
        workspaceId,
        databaseId,
        automationId: automation.id,
        expectedRevision: automation.revision,
      });
      setAutomations((current) => current.filter((item) => item.id !== automation.id));
      if (editing !== "new" && editing?.id === automation.id) setEditing(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("databaseView:automationDeleteFailed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <button
        type="button"
        className={styles.automationRailBackdrop}
        aria-label={t("databaseView:closeAutomations")}
        onClick={onClose}
      />
      <aside className={styles.automationRail} role="dialog" aria-modal="true" aria-label={t("databaseView:automations")}>
        <header className={styles.automationRailHeader}>
          <strong>{t("databaseView:automations")}</strong>
          <button type="button" aria-label={t("databaseView:closeAutomations")} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {editing ? (
          <section className={styles.automationEditor} aria-label={t("databaseView:automationEditor")}>
            <label>
              <span>{t("databaseView:automationName")}</span>
              <input
                autoFocus
                maxLength={100}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
              />
            </label>
            <div className={styles.automationSummaryRow}>
              <span>{t("databaseView:automationTrigger")}</span>
              <strong>{editing !== "new" && editing.triggerType === "schedule"
                ? t("databaseView:recurring")
                : t("databaseView:pageAdded")}</strong>
            </div>
            <AutomationActionEditor
              surface={editing !== "new" && editing.triggerType === "schedule"
                ? "schedule_automation"
                : "event_automation"}
              actions={draftActions}
              properties={editableProperties}
              pages={editorPages}
              views={views}
              onChange={setDraftActions}
            />
            <div className={styles.automationEditorActions}>
              <button type="button" onClick={() => setEditing(null)}>{t("common:actions.cancel")}</button>
              <button
                type="button"
                className={styles.automationPrimaryButton}
                disabled={!draftName.trim() || !automationEditorActionsValid(
                  draftActions,
                  editing !== "new" && editing.triggerType === "schedule"
                    ? "schedule_automation"
                    : "event_automation",
                ) || busyId !== null}
                onClick={() => void saveDraft()}
              >
                {t("common:actions.save")}
              </button>
            </div>
          </section>
        ) : (
          <>
            <button
              type="button"
              className={styles.automationNewButton}
              disabled={loading || automations.length >= 20 || editableProperties.length === 0}
              onClick={beginCreate}
            >
              <Plus size={15} aria-hidden="true" />
              {t("databaseView:newAutomation")}
            </button>
            {loading && <div className={styles.automationRailEmpty}>{t("databaseView:loadingAutomations")}</div>}
            {!loading && automations.length === 0 && (
              <div className={styles.automationRailEmpty}>{t("databaseView:noAutomations")}</div>
            )}
            <div className={styles.automationList}>
              {automations.map((automation) => {
                const statusLabel = automation.status === "active"
                  ? t("databaseView:automationActive")
                  : automation.status === "paused"
                    ? t("databaseView:automationPaused")
                    : t("databaseView:automationDisabled");
                const toggleLabel = automation.status === "active"
                  ? t("databaseView:pauseAutomation", { name: automation.name })
                  : t("databaseView:enableAutomation", { name: automation.name });
                return (
                  <article key={automation.id} className={styles.automationListItem}>
                    <div>
                      <strong>{automation.name}</strong>
                      <span>{statusLabel}</span>
                    </div>
                    <div className={styles.automationListActions}>
                      <button type="button" disabled={busyId !== null} aria-label={t("databaseView:editAutomationNamed", { name: automation.name })} onClick={() => beginEdit(automation)}>
                        {t("databaseView:edit")}
                      </button>
                      <button type="button" disabled={busyId !== null} aria-label={toggleLabel} onClick={() => void toggleAutomation(automation)}>
                        {automation.status === "active" ? t("databaseView:pause") : t("databaseView:enable")}
                      </button>
                      <button type="button" disabled={busyId !== null} aria-label={t("databaseView:deleteAutomationNamed", { name: automation.name })} onClick={() => void deleteAutomation(automation)}>
                        <Trash size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
        {error && <p className={styles.automationRailError} role="alert">{error}</p>}
        {views.length > 0 && !editing && (
          <p className={styles.automationRailHint}>{t("databaseView:automationViewScopeHint")}</p>
        )}
      </aside>
    </>
  );
}
