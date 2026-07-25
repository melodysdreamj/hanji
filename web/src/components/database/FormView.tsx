"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ArrowDown, ArrowUp, Copy, LinkIcon, Plus, Trash } from "@/icons/hanji";
import { copyText } from "@/lib/clipboard";
import { configureFormRemote } from "@/lib/edgebase";
import {
  absoluteFormUrl,
  createDefaultFormViewConfig,
  createFormQuestion,
  FORM_VIEW_MAX_QUESTIONS,
  formQuestionLabel,
  formRequiresWorkspaceAudience,
  isFormViewProperty,
} from "@/lib/formView";
import { useStore } from "@/lib/store";
import type {
  DbProperty,
  DbView,
  FormAudience,
  FormButtonColor,
  FormViewConfig,
  FormViewQuestion,
  Page,
} from "@/lib/types";
import { FormHeader, FormQuestionFields, FormSubmitButton } from "../forms/FormSurface";
import styles from "./FormView.module.css";

function cloneConfig(config: FormViewConfig): FormViewConfig {
  return typeof structuredClone === "function"
    ? structuredClone(config)
    : JSON.parse(JSON.stringify(config)) as FormViewConfig;
}

function formForView(view: DbView, properties: DbProperty[], title: string) {
  return view.config?.hanjiForm
    ? cloneConfig(view.config.hanjiForm)
    : createDefaultFormViewConfig(properties, { title });
}

function reindexQuestions(questions: FormViewQuestion[]) {
  return questions.map((question, position) => ({ ...question, position }));
}

export function FormView({ db, view, readOnly }: { db: Page; view: DbView; readOnly: boolean }) {
  const { t } = useTranslation(["formView", "databaseView", "common"]);
  const properties = useStore(useShallow((state) => state.dbProperties(db.id)));
  const addProperty = useStore((state) => state.addProperty);
  const applyConfiguredView = useStore((state) => state.applyConfiguredView);
  const defaultForm = useMemo(
    () => formForView(view, properties, db.title),
    [db.title, properties, view],
  );
  const [draft, setDraft] = useState(defaultForm);
  const [audience, setAudience] = useState<FormAudience>(view.config?.hanjiFormAudience ?? "none");
  const [selectedPropertyId, setSelectedPropertyId] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [previewValues, setPreviewValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (dirty) return;
    setDraft(defaultForm);
    setAudience(view.config?.hanjiFormAudience ?? "none");
  }, [defaultForm, dirty, view.config?.hanjiFormAudience]);

  const propertiesById = useMemo(
    () => new Map(properties.map((property) => [property.id, property])),
    [properties],
  );
  const usedIds = new Set(draft.questions.map((question) => question.propertyId));
  const availableProperties = properties.filter((property) => isFormViewProperty(property) && !usedIds.has(property.id));
  const unsupportedProperties = properties.filter((property) => !isFormViewProperty(property));
  const persisted = Boolean(view.createdAt || view.updatedAt);
  const configurationReady = persisted && draft.questions.every((question) => {
    const property = propertiesById.get(question.propertyId);
    return Boolean(property && (property.createdAt || property.updatedAt));
  });
  const requiresWorkspaceAudience = formRequiresWorkspaceAudience(draft, properties);
  const audienceCompatible = !requiresWorkspaceAudience || audience !== "web";

  function changeDraft(update: (current: FormViewConfig) => FormViewConfig) {
    setDraft((current) => update(current));
    setDirty(true);
    setStatus("");
    setError("");
  }

  function updateQuestion(id: string, patch: Partial<FormViewQuestion>) {
    changeDraft((current) => ({
      ...current,
      questions: current.questions.map((question) => question.id === id ? { ...question, ...patch } : question),
    }));
  }

  function moveQuestion(index: number, offset: -1 | 1) {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= draft.questions.length) return;
    changeDraft((current) => {
      const questions = current.questions.slice();
      [questions[index], questions[nextIndex]] = [questions[nextIndex], questions[index]];
      return { ...current, questions: reindexQuestions(questions) };
    });
  }

  function addExistingQuestion() {
    const property = propertiesById.get(selectedPropertyId);
    if (!property || draft.questions.length >= FORM_VIEW_MAX_QUESTIONS) return;
    changeDraft((current) => ({
      ...current,
      questions: [...current.questions, createFormQuestion(property, current.questions.length)],
    }));
    setSelectedPropertyId("");
  }

  async function duplicateQuestion(question: FormViewQuestion) {
    const source = propertiesById.get(question.propertyId);
    if (!source || source.type === "title" || saving) return;
    const copyName = t("databaseView:copyName", { name: source.name });
    const config = source.config
      ? (typeof structuredClone === "function" ? structuredClone(source.config) : JSON.parse(JSON.stringify(source.config)))
      : undefined;
    const created = await addProperty(db.id, source.type, copyName, config);
    if (!created) return;
    changeDraft((current) => {
      const index = current.questions.findIndex((item) => item.id === question.id);
      const duplicate = {
        ...createFormQuestion(created, index + 1),
        description: question.description,
        required: question.required,
        longAnswer: question.longAnswer,
        optionsDisplay: question.optionsDisplay,
        maxSelections: question.maxSelections,
      };
      const questions = current.questions.slice();
      questions.splice(index + 1, 0, duplicate);
      return { ...current, questions: reindexQuestions(questions) };
    });
  }

  async function save(copyLinkAfter = false) {
    if (!configurationReady || !audienceCompatible || saving) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const result = await configureFormRemote({
        databaseId: db.id,
        viewId: view.id,
        form: draft,
        audience,
      });
      applyConfiguredView(result.view);
      setDraft(cloneConfig(result.form));
      setAudience(result.formLink.audience);
      setDirty(false);
      if (copyLinkAfter && result.formLink.enabled) {
        const copied = await copyText(absoluteFormUrl(result.formLink.token));
        if (!copied) throw new Error(t("formView:copyLinkFailed"));
        setStatus(t("formView:linkCopied"));
      } else {
        setStatus(t("formView:saved"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const preview = (
    <div className={styles.previewCard} data-form-preview>
      <FormHeader form={draft} />
      {draft.questions.length === 0 && <p className={styles.empty}>{t("formView:noQuestions")}</p>}
      <FormQuestionFields
        form={draft}
        properties={properties}
        values={previewValues}
        disabled={readOnly}
        onChange={(propertyId, value) => setPreviewValues((current) => ({ ...current, [propertyId]: value }))}
      />
      <FormSubmitButton form={draft} disabled label={draft.submit.buttonLabel} />
    </div>
  );

  if (readOnly) return <div className={styles.readOnly}>{preview}</div>;

  return (
    <div className={styles.root} data-form-builder>
      <div className={styles.mobileUnsupported} role="note">
        <strong>{t("formView:mobileAuthoringTitle")}</strong>
        <span>{t("formView:mobileAuthoringBody")}</span>
      </div>
      <div className={styles.desktopBuilder}>
        <aside className={styles.editor} aria-label={t("formView:editForm")}>
          <div className={styles.shareBar}>
            <label>
              <span>{t("formView:audience")}</span>
              <select
                value={audience}
                onChange={(event) => {
                  setAudience(event.currentTarget.value as FormAudience);
                  setDirty(true);
                  setStatus("");
                }}
              >
                <option value="none">{t("formView:audienceNone")}</option>
                <option value="workspace">{t("formView:audienceWorkspace")}</option>
                <option value="web" disabled={requiresWorkspaceAudience}>{t("formView:audienceWeb")}</option>
              </select>
            </label>
            <div className={styles.shareActions}>
              <button type="button" disabled={!configurationReady || !audienceCompatible || saving} onClick={() => void save(false)}>
                {saving ? t("formView:saving") : t("formView:save")}
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={!configurationReady || !audienceCompatible || saving || audience === "none"}
                onClick={() => void save(true)}
              >
                <LinkIcon size={14} aria-hidden="true" />
                {t("formView:share")}
              </button>
            </div>
            {!configurationReady && <p className={styles.pending}>{t("formView:setupPending")}</p>}
            {!audienceCompatible && (
              <p className={styles.error} role="alert">{t("formView:referenceAudienceRequired")}</p>
            )}
            {status && <p className={styles.success} role="status">{status}</p>}
            {error && <p className={styles.error} role="alert">{error}</p>}
          </div>

          <section className={styles.panel}>
            <label className={styles.field}>
              <span>{t("formView:title")}</span>
              <input value={draft.title} onChange={(event) => changeDraft((form) => ({ ...form, title: event.target.value }))} />
            </label>
            <label className={styles.field}>
              <span>{t("formView:description")}</span>
              <textarea rows={3} value={draft.description} onChange={(event) => changeDraft((form) => ({ ...form, description: event.target.value }))} />
            </label>
            <label className={styles.field}>
              <span>{t("formView:icon")}</span>
              <input placeholder={t("formView:iconPlaceholder")} value={draft.icon} onChange={(event) => changeDraft((form) => ({ ...form, icon: event.target.value }))} />
            </label>
            <label className={styles.field}>
              <span>{t("databaseView:pageCover")}</span>
              <input value={draft.cover} onChange={(event) => changeDraft((form) => ({ ...form, cover: event.target.value }))} />
            </label>
          </section>

          <div className={styles.questionEditors}>
            {draft.questions.map((question, index) => {
              const property = propertiesById.get(question.propertyId);
              if (!property) return null;
              const choice = property.type === "select" || property.type === "status" || property.type === "multi_select";
              const multiple = property.type === "multi_select" || property.type === "person" || property.type === "relation";
              return (
                <section
                  className={styles.questionEditor}
                  data-form-question-editor={property.id}
                  key={question.id}
                >
                  <div className={styles.questionEditorTop}>
                    <span className={styles.questionNumber}>{index + 1}</span>
                    <strong>{formQuestionLabel(question, property)}</strong>
                    <div className={styles.iconActions}>
                      <button type="button" aria-label={t("formView:moveUp")} disabled={index === 0} onClick={() => moveQuestion(index, -1)}><ArrowUp size={14} /></button>
                      <button type="button" aria-label={t("formView:moveDown")} disabled={index === draft.questions.length - 1} onClick={() => moveQuestion(index, 1)}><ArrowDown size={14} /></button>
                      <button type="button" aria-label={t("formView:duplicateQuestion")} disabled={property.type === "title"} onClick={() => void duplicateQuestion(question)}><Copy size={14} /></button>
                      <button type="button" aria-label={t("formView:removeQuestion")} onClick={() => changeDraft((form) => ({ ...form, questions: reindexQuestions(form.questions.filter((item) => item.id !== question.id)) }))}><Trash size={14} /></button>
                    </div>
                  </div>
                  <label className={styles.checkField}>
                    <input type="checkbox" checked={question.syncWithPropertyName} onChange={(event) => updateQuestion(question.id, { syncWithPropertyName: event.target.checked, label: event.target.checked ? property.name : question.label })} />
                    <span>{t("formView:syncPropertyName")}</span>
                  </label>
                  <label className={styles.field}>
                    <span>{t("formView:label")}</span>
                    <input disabled={question.syncWithPropertyName} value={question.syncWithPropertyName ? property.name : question.label} onChange={(event) => updateQuestion(question.id, { label: event.target.value })} />
                  </label>
                  <label className={styles.field}>
                    <span>{t("formView:questionDescription")}</span>
                    <textarea rows={2} value={question.description} onChange={(event) => updateQuestion(question.id, { description: event.target.value })} />
                  </label>
                  <div className={styles.inlineSettings}>
                    <label className={styles.checkField}>
                      <input type="checkbox" checked={question.required} onChange={(event) => updateQuestion(question.id, { required: event.target.checked })} />
                      <span>{t("formView:answerRequired")}</span>
                    </label>
                    {property.type === "rich_text" && (
                      <label className={styles.checkField}>
                        <input type="checkbox" checked={question.longAnswer === true} onChange={(event) => updateQuestion(question.id, { longAnswer: event.target.checked })} />
                        <span>{t("formView:longAnswer")}</span>
                      </label>
                    )}
                  </div>
                  {choice && (
                    <div className={styles.inlineSettings}>
                      <select value={question.optionsDisplay ?? "list"} onChange={(event) => updateQuestion(question.id, { optionsDisplay: event.target.value as "list" | "dropdown" })}>
                        <option value="list">{t("formView:optionsList")}</option>
                        <option value="dropdown">{t("formView:optionsDropdown")}</option>
                      </select>
                    </div>
                  )}
                  {multiple && (
                    <div className={styles.inlineSettings}>
                      <label className={styles.compactField}>
                        <span>{t("formView:maxSelections")}</span>
                        <input type="number" min={1} max={50} value={question.maxSelections ?? 50} onChange={(event) => updateQuestion(question.id, { maxSelections: Math.max(1, Math.min(50, Number(event.target.value) || 1)) })} />
                      </label>
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          <section className={styles.addQuestion}>
            <select value={selectedPropertyId} onChange={(event) => setSelectedPropertyId(event.target.value)}>
              <option value="">{t("formView:selectProperty")}</option>
              {availableProperties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
            </select>
            <button type="button" disabled={!selectedPropertyId || draft.questions.length >= FORM_VIEW_MAX_QUESTIONS} onClick={addExistingQuestion}>
              <Plus size={14} aria-hidden="true" />
              {t("formView:addQuestion")}
            </button>
          </section>

          {unsupportedProperties.length > 0 && (
            <details className={styles.unsupported}>
              <summary>{t("formView:unsupportedProperties")}</summary>
              <ul>{unsupportedProperties.map((property) => <li key={property.id}>{property.name} · {t("formView:propertyUnavailable")}</li>)}</ul>
            </details>
          )}

          <section className={styles.panel}>
            <label className={styles.field}>
              <span>{t("formView:buttonLabel")}</span>
              <input value={draft.submit.buttonLabel} onChange={(event) => changeDraft((form) => ({ ...form, submit: { ...form.submit, buttonLabel: event.target.value } }))} />
            </label>
            <label className={styles.field}>
              <span>{t("formView:confirmationTitle")}</span>
              <input value={draft.submit.confirmationTitle} onChange={(event) => changeDraft((form) => ({ ...form, submit: { ...form.submit, confirmationTitle: event.target.value } }))} />
            </label>
            <label className={styles.field}>
              <span>{t("formView:confirmationBody")}</span>
              <textarea rows={2} value={draft.submit.confirmationBody} onChange={(event) => changeDraft((form) => ({ ...form, submit: { ...form.submit, confirmationBody: event.target.value } }))} />
            </label>
            <label className={styles.field}>
              <span>{t("formView:buttonColor")}</span>
              <select value={draft.submit.buttonColor} onChange={(event) => changeDraft((form) => ({ ...form, submit: { ...form.submit, buttonColor: event.target.value as FormButtonColor } }))}>
                {(["blue", "gray", "green", "red", "orange", "purple"] as FormButtonColor[]).map((color) => <option key={color} value={color}>{color}</option>)}
              </select>
            </label>
          </section>
        </aside>
        <section className={styles.preview} aria-label={t("formView:preview")}>
          <div className={styles.previewLabel}>{t("formView:preview")}</div>
          {preview}
        </section>
      </div>
    </div>
  );
}
