"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DbProperty,
  FormPublicProperty,
  FormReferenceOption,
  FormViewConfig,
  FormViewQuestion,
} from "@/lib/types";
import {
  FORM_VIEW_MAX_REFERENCE_SELECTIONS,
  formQuestionLabel,
} from "@/lib/formView";
import styles from "./FormSurface.module.css";

type FormProperty = DbProperty | FormPublicProperty;

function isImage(value: string) {
  return /^(https?:\/\/|data:image\/|blob:|\/)/i.test(value.trim());
}

export function FormHeader({ form }: { form: FormViewConfig }) {
  return (
    <header className={styles.header}>
      {form.cover && <img className={styles.cover} src={form.cover} alt="" />}
      <div className={styles.headerBody}>
        {form.icon && (
          isImage(form.icon)
            ? <img className={styles.iconImage} src={form.icon} alt="" />
            : <span className={styles.iconEmoji} aria-hidden="true">{form.icon}</span>
        )}
        <h1 className={styles.title}>{form.title}</h1>
        {form.description && <p className={styles.description}>{form.description}</p>}
      </div>
    </header>
  );
}

function optionList(property: FormProperty) {
  return Array.isArray(property.config?.options) ? property.config.options : [];
}

function textField(
  property: FormProperty,
  question: FormViewQuestion,
  value: unknown,
  disabled: boolean,
  onChange: (value: unknown) => void,
) {
  const common = {
    id: `form-answer-${property.id}`,
    name: property.id,
    disabled,
    required: question.required,
    value: typeof value === "string" || typeof value === "number" ? value : "",
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  if (property.type === "rich_text" && question.longAnswer) {
    return <textarea {...common} className={styles.textarea} rows={4} />;
  }
  const type = property.type === "number"
    ? "number"
    : property.type === "date"
      ? "date"
      : property.type === "email"
        ? "email"
        : property.type === "phone"
          ? "tel"
          : property.type === "url"
            ? "url"
            : "text";
  return <input {...common} className={styles.input} type={type} />;
}

function choiceField(
  property: FormProperty,
  question: FormViewQuestion,
  value: unknown,
  disabled: boolean,
  onChange: (value: unknown) => void,
) {
  const options = optionList(property);
  const multi = property.type === "multi_select";
  const selected = multi && Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  if (question.optionsDisplay === "dropdown") {
    return (
      <select
        id={`form-answer-${property.id}`}
        className={multi ? styles.multiSelect : styles.select}
        name={property.id}
        disabled={disabled}
        required={question.required}
        multiple={multi}
        value={multi ? selected : typeof value === "string" ? value : ""}
        onChange={(event) => {
          if (multi) {
            const next = Array.from(event.currentTarget.selectedOptions, (option) => option.value)
              .slice(0, question.maxSelections ?? 50);
            onChange(next);
          } else {
            onChange(event.currentTarget.value);
          }
        }}
      >
        {!multi && <option value="" />}
        {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    );
  }
  return (
    <div className={styles.choiceList} role={multi ? "group" : "radiogroup"} aria-required={question.required}>
      {options.map((option) => {
        const checked = multi ? selected.includes(option.id) : value === option.id;
        return (
          <label key={option.id} className={styles.choice}>
            <input
              type={multi ? "checkbox" : "radio"}
              name={property.id}
              value={option.id}
              checked={checked}
              disabled={disabled || (multi && !checked && selected.length >= (question.maxSelections ?? 50))}
              required={!multi && question.required}
              onChange={(event) => {
                if (!multi) {
                  onChange(option.id);
                  return;
                }
                const next = event.currentTarget.checked
                  ? [...selected, option.id].slice(0, question.maxSelections ?? 50)
                  : selected.filter((id) => id !== option.id);
                onChange(next);
              }}
            />
            <span className={styles.choiceMarker} aria-hidden="true" />
            <span>{option.name}</span>
          </label>
        );
      })}
    </div>
  );
}

function ReferenceField({
  property,
  label,
  value,
  disabled,
  options,
  loading,
  error,
  hasMore,
  maxSelections,
  onRequest,
  onChange,
}: {
  property: FormProperty;
  label: string;
  value: unknown;
  disabled: boolean;
  options: FormReferenceOption[] | undefined;
  loading: boolean;
  error: string | undefined;
  hasMore: boolean;
  maxSelections: number;
  onRequest: (append: boolean) => void;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation(["formView", "common"]);
  const [open, setOpen] = useState(false);
  const selected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const selectedNames = (options ?? [])
    .filter((option) => selected.includes(option.id))
    .map((option) => option.name);
  const controlId = `form-answer-${property.id}`;

  return (
    <div className={styles.referenceField}>
      <button
        id={controlId}
        type="button"
        className={styles.referenceTrigger}
        aria-expanded={open}
        aria-label={t("formView:chooseReference", { label })}
        disabled={disabled}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && options === undefined && !loading) onRequest(false);
        }}
      >
        <span>
          {selectedNames.length > 0
            ? selectedNames.join(", ")
            : selected.length > 0
              ? t("formView:selectedCount", { count: selected.length })
              : t("formView:choose")}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          className={styles.referencePanel}
          role="group"
          aria-label={label}
        >
          {loading && options === undefined && (
            <p className={styles.referenceState} role="status">{t("formView:loadingChoices")}</p>
          )}
          {error && (
            <div className={styles.referenceState} role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => onRequest(false)}>{t("common:retry")}</button>
            </div>
          )}
          {options?.map((option) => {
            const checked = selected.includes(option.id);
            return (
              <label className={styles.referenceOption} key={option.id}>
                <input
                  type="checkbox"
                  name={property.id}
                  value={option.id}
                  checked={checked}
                  disabled={disabled || (!checked && selected.length >= maxSelections)}
                  onChange={(event) => {
                    const next = event.currentTarget.checked
                      ? [...selected, option.id].slice(0, maxSelections)
                      : selected.filter((id) => id !== option.id);
                    onChange(next);
                  }}
                />
                {option.avatar
                  ? <img className={styles.referenceAvatar} src={option.avatar} alt="" />
                  : <span className={styles.referenceAvatarFallback} aria-hidden="true">{option.name.slice(0, 1).toUpperCase()}</span>}
                <span>{option.name}</span>
              </label>
            );
          })}
          {options && options.length === 0 && !loading && !error && (
            <p className={styles.referenceState}>{t("formView:noChoices")}</p>
          )}
          {hasMore && (
            <button
              type="button"
              className={styles.loadMore}
              disabled={loading}
              onClick={() => onRequest(true)}
            >
              {loading ? t("formView:loadingChoices") : t("formView:loadMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function FormQuestionFields({
  form,
  properties,
  values,
  disabled = false,
  referenceOptions = {},
  referenceLoading = {},
  referenceErrors = {},
  referenceHasMore = {},
  onRequestReferenceOptions,
  onChange,
}: {
  form: FormViewConfig;
  properties: FormProperty[];
  values: Record<string, unknown>;
  disabled?: boolean;
  referenceOptions?: Record<string, FormReferenceOption[] | undefined>;
  referenceLoading?: Record<string, boolean>;
  referenceErrors?: Record<string, string | undefined>;
  referenceHasMore?: Record<string, boolean>;
  onRequestReferenceOptions?: (propertyId: string, append: boolean) => void;
  onChange: (propertyId: string, value: unknown) => void;
}) {
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  const referenceSelectionCount = properties.reduce((count, property) => {
    if (property.type !== "person" && property.type !== "relation") return count;
    const value = values[property.id];
    return count + (Array.isArray(value) ? value.length : 0);
  }, 0);
  return (
    <div className={styles.questions}>
      {form.questions.filter((question) => !question.hidden).map((question) => {
        const property = propertiesById.get(question.propertyId);
        if (!property) return null;
        const label = formQuestionLabel(question, property);
        const value = values[property.id];
        const selectedHere = Array.isArray(value) ? value.length : 0;
        const remainingReferenceSelections = Math.max(
          0,
          FORM_VIEW_MAX_REFERENCE_SELECTIONS - (referenceSelectionCount - selectedHere),
        );
        const referenceMax = Math.min(
          question.maxSelections ?? FORM_VIEW_MAX_REFERENCE_SELECTIONS,
          remainingReferenceSelections,
        );
        const field = property.type === "person" || property.type === "relation"
          ? (
            <ReferenceField
              property={property}
              label={label || property.name}
              value={value}
              disabled={disabled}
              options={referenceOptions[property.id]}
              loading={referenceLoading[property.id] === true}
              error={referenceErrors[property.id]}
              hasMore={referenceHasMore[property.id] === true}
              maxSelections={referenceMax}
              onRequest={(append) => onRequestReferenceOptions?.(property.id, append)}
              onChange={(next) => onChange(property.id, next)}
            />
          )
          : property.type === "select" || property.type === "status" || property.type === "multi_select"
          ? choiceField(property, question, value, disabled, (next) => onChange(property.id, next))
          : property.type === "checkbox"
            ? (
              <span className={styles.checkboxAnswer}>
                <input
                  id={`form-answer-${property.id}`}
                  type="checkbox"
                  name={property.id}
                  disabled={disabled}
                  required={question.required}
                  checked={value === true}
                  onChange={(event) => onChange(property.id, event.currentTarget.checked)}
                />
                <span aria-hidden="true" />
              </span>
            )
            : textField(property, question, value, disabled, (next) => onChange(property.id, next));
        return (
          <section className={styles.question} key={question.id} data-form-question={property.id}>
            <label className={styles.questionLabel} htmlFor={`form-answer-${property.id}`}>
              {label || property.name}
              {question.required && <span className={styles.required} aria-hidden="true">*</span>}
            </label>
            {question.description && <p className={styles.questionDescription}>{question.description}</p>}
            {field}
          </section>
        );
      })}
    </div>
  );
}

export function FormSubmitButton({
  form,
  disabled,
  label,
}: {
  form: FormViewConfig;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="submit"
      className={styles.submit}
      data-color={form.submit.buttonColor}
      disabled={disabled}
    >
      {label ?? form.submit.buttonLabel}
    </button>
  );
}
