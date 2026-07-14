"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { isolateBodyForModal, trapModalTab } from "@/lib/modalFocus";
import { X } from "./icons";
import styles from "./NotionImportOnboardingDialog.module.css";

export function NotionImportOnboardingDialog({
  onImport,
  onLater,
}: {
  onImport: () => void;
  onLater: () => void;
}) {
  const { t } = useTranslation(["sidebar", "common"]);
  const titleId = useId();
  const bodyId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreIsolation = isolateBodyForModal([overlayRef.current]);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => primaryRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      restoreIsolation();
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore?.isConnected) window.requestAnimationFrame(() => restore.focus());
    };
  }, []);

  const dialog = (
    <div ref={overlayRef} className={styles.overlay} data-notion-import-onboarding>
      <button
        type="button"
        className={styles.backdrop}
        onClick={onLater}
        tabIndex={-1}
        aria-label={t("common:actions.close")}
      />
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onLater();
            return;
          }
          trapModalTab(event, dialogRef.current);
        }}
      >
        <button
          type="button"
          className={styles.close}
          onClick={onLater}
          aria-label={t("common:actions.close")}
        >
          <X size={18} aria-hidden="true" />
        </button>
        <div className={styles.mark} aria-hidden="true">N</div>
        <div className={styles.copy}>
          <h2 id={titleId}>{t("sidebar:notionOnboarding.title")}</h2>
          <p id={bodyId}>{t("sidebar:notionOnboarding.body")}</p>
          <p className={styles.note}>{t("sidebar:notionOnboarding.note")}</p>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onLater}>
            {t("sidebar:notionOnboarding.later")}
          </button>
          <button ref={primaryRef} type="button" className={styles.primary} onClick={onImport}>
            {t("sidebar:notionOnboarding.import")}
          </button>
        </div>
      </section>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
