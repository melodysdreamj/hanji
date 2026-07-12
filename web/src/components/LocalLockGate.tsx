"use client";

// Boot-time unlock dialog for the local data lock (passphrase key custody).
// Shown only when the encryption mode is "passphrase" and this session has
// not unlocked yet. Skipping keeps the session network-only: the outbox and
// record cache stay disabled, so locked data is neither read nor written.

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { localLockPending, skipLocalLock, unlockLocalData } from "@/lib/localLock";
import { isolateBodyForModal, trapModalTab } from "@/lib/modalFocus";

import styles from "./LocalLockGate.module.css";

export default function LocalLockGate({
  userId,
  onUnlocked,
}: {
  userId: string;
  onUnlocked?: () => void;
}) {
  const [pending, setPending] = useState(() => localLockPending(userId));
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"" | "wrong-passphrase" | "unsupported">("");
  const { t } = useTranslation(["localLockGate", "common"]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!pending) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreIsolation = isolateBodyForModal([dialogRef.current]);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      restoreIsolation();
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore?.isConnected) window.requestAnimationFrame(() => restore.focus());
    };
  }, [pending]);

  if (!pending) return null;

  async function unlock() {
    if (!passphrase || busy) return;
    setBusy(true);
    setError("");
    const result = await unlockLocalData(userId, passphrase);
    setBusy(false);
    if (result === "ok") {
      setPending(false);
      onUnlocked?.();
      return;
    }
    setError(result === "wrong-passphrase" ? "wrong-passphrase" : "unsupported");
  }

  function skip() {
    skipLocalLock(userId);
    setPending(false);
  }

  const dialog = (
    <div
      ref={dialogRef}
      className={styles.backdrop}
      data-testid="local-lock-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") return;
        trapModalTab(event, dialogRef.current);
      }}
    >
      <div className={styles.card}>
        <strong id={titleId} className={styles.title}>{t("localLockGate:title")}</strong>
        <p id={descriptionId} className={styles.desc}>{t("localLockGate:description")}</p>
        <input
          ref={inputRef}
          type="password"
          className={styles.input}
          data-testid="local-lock-passphrase"
          aria-label={t("localLockGate:passphrasePlaceholder")}
          placeholder={t("localLockGate:passphrasePlaceholder")}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void unlock();
          }}
        />
        {error ? (
          <p className={styles.error} data-testid="local-lock-error" role="alert">
            {error === "wrong-passphrase"
              ? t("localLockGate:wrongPassphrase")
              : t("localLockGate:unsupportedBrowser")}
          </p>
        ) : null}
        {error === "wrong-passphrase" ? (
          <p className={styles.desc} data-testid="local-lock-continue-hint">
            {t("localLockGate:continueOnlineHint")}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            data-testid="local-lock-unlock"
            disabled={busy || !passphrase}
            onClick={() => void unlock()}
          >
            {t("localLockGate:unlock")}
          </button>
          <button
            type="button"
            className={styles.secondary}
            data-testid="local-lock-skip"
            onClick={skip}
          >
            {t("localLockGate:continueOnline")}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
