"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { isolateBodyForModal, trapModalTab } from "@/lib/modalFocus";
import type { Workspace } from "@/lib/types";
import { X } from "./icons";
import styles from "./WorkspaceCreateDialog.module.css";

export type WorkspaceCreateChoice = "blank" | "notion" | "hanji";

export function WorkspaceCreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  /**
   * Creates the workspace (choice !== "blank" skips the starter pages) and
   * resolves with the created workspace; the caller owns navigation and the
   * follow-up import dialog.
   */
  onCreate: (input: { name: string; choice: WorkspaceCreateChoice }) => Promise<Workspace>;
}) {
  const { t } = useTranslation(["workspaceCreateDialog", "common"]);
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const [choice, setChoice] = useState<WorkspaceCreateChoice>("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreIsolation = isolateBodyForModal([overlayRef.current]);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      restoreIsolation();
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore?.isConnected) window.requestAnimationFrame(() => restore.focus());
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), choice });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("workspaceCreateDialog:error.couldntCreate"));
      setBusy(false);
    }
  }

  const options: Array<{ key: WorkspaceCreateChoice; title: string; body: string }> = [
    {
      key: "blank",
      title: t("workspaceCreateDialog:options.blank.title"),
      body: t("workspaceCreateDialog:options.blank.body"),
    },
    {
      key: "notion",
      title: t("workspaceCreateDialog:options.notion.title"),
      body: t("workspaceCreateDialog:options.notion.body"),
    },
    {
      key: "hanji",
      title: t("workspaceCreateDialog:options.hanji.title"),
      body: t("workspaceCreateDialog:options.hanji.body"),
    },
  ];

  const dialog = (
    <div ref={overlayRef} className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        onClick={onClose}
        tabIndex={-1}
        aria-label={t("common:actions.close")}
      />
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          trapModalTab(event, dialogRef.current);
        }}
      >
        <header className={styles.header}>
          <h2 id={titleId}>{t("workspaceCreateDialog:title")}</h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={t("common:actions.close")}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <form className={styles.body} onSubmit={submit}>
          <label className={styles.label} htmlFor="workspace-create-name">
            {t("workspaceCreateDialog:name.label")}
          </label>
          <input
            id="workspace-create-name"
            ref={nameRef}
            className={styles.nameInput}
            value={name}
            placeholder={t("workspaceCreateDialog:name.placeholder")}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <span className={styles.label}>{t("workspaceCreateDialog:startLabel")}</span>
          <div
            className={styles.options}
            role="radiogroup"
            aria-label={t("workspaceCreateDialog:startLabel")}
          >
            {options.map((option) => (
              <button
                key={option.key}
                type="button"
                className={styles.option}
                role="radio"
                aria-checked={choice === option.key}
                data-active={choice === option.key ? "true" : undefined}
                disabled={busy}
                onClick={() => setChoice(option.key)}
              >
                <span className={styles.optionTitle}>{option.title}</span>
                <span className={styles.optionBody}>{option.body}</span>
              </button>
            ))}
          </div>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>
              {t("common:actions.cancel")}
            </button>
            <button type="submit" className={styles.primary} disabled={busy}>
              {busy ? t("workspaceCreateDialog:creating") : t("workspaceCreateDialog:create")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
