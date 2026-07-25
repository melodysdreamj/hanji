"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getFormDefinitionRemote,
  getFormOptionsRemote,
  restoreAuthSessionRemote,
  submitFormRemote,
} from "@/lib/edgebase";
import { buildFormSubmissionAnswers } from "@/lib/formView";
import type {
  FormDefinitionResult,
  FormReferenceOption,
  FormSubmitResult,
} from "@/lib/types";
import {
  FormHeader,
  FormQuestionFields,
  FormSubmitButton,
} from "./forms/FormSurface";
import styles from "./PublicFormView.module.css";

type LoadFailure = "signin" | "unavailable" | "error";

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const value = record.status ?? record.code;
  return typeof value === "number" ? value : null;
}

function requestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `response-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function PublicFormView({ token }: { token: string }) {
  const { t } = useTranslation(["formView", "common"]);
  const [definition, setDefinition] = useState<FormDefinitionResult | null>(null);
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [confirmation, setConfirmation] = useState<FormSubmitResult["confirmation"] | null>(null);
  const [referenceOptions, setReferenceOptions] = useState<Record<string, FormReferenceOption[] | undefined>>({});
  const [referenceAfter, setReferenceAfter] = useState<Record<string, string | null | undefined>>({});
  const [referenceHasMore, setReferenceHasMore] = useState<Record<string, boolean>>({});
  const [referenceLoading, setReferenceLoading] = useState<Record<string, boolean>>({});
  const [referenceErrors, setReferenceErrors] = useState<Record<string, string | undefined>>({});
  const requestIdRef = useRef("");
  const optionFlightsRef = useRef(new Map<string, Promise<void>>());
  const optionGenerationRef = useRef(0);

  const resetReferenceOptions = useCallback(() => {
    optionGenerationRef.current += 1;
    optionFlightsRef.current.clear();
    setReferenceOptions({});
    setReferenceAfter({});
    setReferenceHasMore({});
    setReferenceLoading({});
    setReferenceErrors({});
  }, []);

  const load = useCallback(async (allowAuthRetry = true) => {
    setLoadFailure(null);
    try {
      const result = await getFormDefinitionRemote(token);
      setDefinition(result);
      resetReferenceOptions();
      return result;
    } catch (error) {
      const status = errorStatus(error);
      if (status === 401 && allowAuthRetry) {
        const userId = await restoreAuthSessionRemote().catch(() => "");
        if (userId) return load(false);
      }
      setDefinition(null);
      setLoadFailure(
        status === 401
          ? "signin"
          : status === 404 || status === 403 || status === 410
            ? "unavailable"
            : "error",
      );
      return null;
    }
  }, [resetReferenceOptions, token]);

  const loadReferenceOptions = useCallback((propertyId: string, append: boolean) => {
    if (optionFlightsRef.current.has(propertyId)) return;
    const after = append ? referenceAfter[propertyId] ?? undefined : undefined;
    if (append && !after) return;
    const generation = optionGenerationRef.current;
    setReferenceLoading((current) => ({ ...current, [propertyId]: true }));
    setReferenceErrors((current) => ({ ...current, [propertyId]: undefined }));
    const flight = getFormOptionsRemote({ token, propertyId, after })
      .then((result) => {
        if (generation !== optionGenerationRef.current) return;
        setReferenceOptions((current) => {
          const combined = append
            ? [...(current[propertyId] ?? []), ...result.options]
            : result.options;
          return {
            ...current,
            [propertyId]: Array.from(
              new Map(combined.map((option) => [option.id, option])).values(),
            ),
          };
        });
        setReferenceAfter((current) => ({ ...current, [propertyId]: result.after }));
        setReferenceHasMore((current) => ({ ...current, [propertyId]: result.hasMore }));
      })
      .catch(() => {
        if (generation !== optionGenerationRef.current) return;
        setReferenceErrors((current) => ({
          ...current,
          [propertyId]: t("formView:choicesFailed"),
        }));
      })
      .finally(() => {
        if (generation !== optionGenerationRef.current) return;
        if (optionFlightsRef.current.get(propertyId) === flight) {
          optionFlightsRef.current.delete(propertyId);
        }
        setReferenceLoading((current) => ({ ...current, [propertyId]: false }));
      });
    optionFlightsRef.current.set(propertyId, flight);
  }, [referenceAfter, t, token]);

  useEffect(() => {
    let active = true;
    void load().then((result) => {
      if (!active || result) return;
    });
    return () => {
      active = false;
    };
  }, [load]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!definition || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    if (!requestIdRef.current) requestIdRef.current = requestId();
    try {
      const result = await submitFormRemote({
        token,
        revision: definition.revision,
        requestId: requestIdRef.current,
        answers: buildFormSubmissionAnswers(definition.form, definition.properties, values),
      });
      setConfirmation(result.confirmation);
      requestIdRef.current = "";
    } catch (error) {
      if (errorStatus(error) === 409) {
        await load(false);
        setSubmitError(t("formView:formChanged"));
      } else {
        setSubmitError(t("formView:responseFailed"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  function submitAnother() {
    setValues({});
    setSubmitError("");
    setConfirmation(null);
    requestIdRef.current = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!definition && !loadFailure) {
    return <main className={styles.page}><div className={styles.state} aria-busy="true">{t("formView:loading")}</div></main>;
  }

  if (!definition) {
    const signin = loadFailure === "signin";
    return (
      <main className={styles.page}>
        <div className={styles.state} role="status" data-form-unavailable={loadFailure}>
          <h1>{signin ? t("formView:signInTitle") : t("formView:unavailableTitle")}</h1>
          <p>{signin ? t("formView:signInBody") : t("formView:unavailableBody")}</p>
          {loadFailure === "error" && (
            <button type="button" onClick={() => void load()}>{t("common:retry")}</button>
          )}
        </div>
      </main>
    );
  }

  if (confirmation) {
    return (
      <main className={styles.page}>
        <section className={styles.confirmation} role="status" data-form-confirmation>
          <div className={styles.confirmationMark} aria-hidden="true">✓</div>
          <h1>{confirmation.confirmationTitle}</h1>
          {confirmation.confirmationBody && <p>{confirmation.confirmationBody}</p>}
          <button type="button" onClick={submitAnother}>{t("formView:submitAnother")}</button>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page} data-public-form>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <FormHeader form={definition.form} />
        <FormQuestionFields
          form={definition.form}
          properties={definition.properties}
          values={values}
          disabled={submitting}
          referenceOptions={referenceOptions}
          referenceLoading={referenceLoading}
          referenceErrors={referenceErrors}
          referenceHasMore={referenceHasMore}
          onRequestReferenceOptions={loadReferenceOptions}
          onChange={(propertyId, value) => setValues((current) => ({ ...current, [propertyId]: value }))}
        />
        {submitError && <p className={styles.error} role="alert">{submitError}</p>}
        <FormSubmitButton
          form={definition.form}
          disabled={submitting}
          label={submitting ? t("formView:submitting") : undefined}
        />
      </form>
    </main>
  );
}
