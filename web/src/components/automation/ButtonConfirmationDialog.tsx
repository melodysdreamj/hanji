"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ButtonConfirmationChallenge } from "@/lib/edgebase";
import styles from "./buttonConfirmationDialog.module.css";

export function ButtonConfirmationDialog({
  challenge,
  busy = false,
  onCancel,
  onConfirm,
}: {
  challenge: ButtonConfirmationChallenge;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const first = challenge.confirmations[0];

  useEffect(() => {
    cancelRef.current?.focus();
  }, [challenge.confirmationToken]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  if (!first || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
      >
        <div className={styles.content}>
          {challenge.confirmations.map((confirmation, index) => (
            <div className={styles.confirmation} key={confirmation.actionId}>
              {index === 0
                ? <h2 id={titleId}>{confirmation.title}</h2>
                : <h3>{confirmation.title}</h3>}
              <p>{confirmation.message}</p>
            </div>
          ))}
        </div>
        <div className={styles.actions}>
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
            {first.cancelLabel}
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={onConfirm}
          >
            {first.confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
