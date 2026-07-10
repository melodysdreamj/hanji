"use client";

// Boot-time unlock dialog for the local data lock (passphrase key custody).
// Shown only when the encryption mode is "passphrase" and this session has
// not unlocked yet. Skipping keeps the session network-only: the outbox and
// record cache stay disabled, so locked data is neither read nor written.

import { useState } from "react";

import { pickLabels } from "@/lib/i18n";
import { localLockPending, skipLocalLock, unlockLocalData } from "@/lib/localLock";

import styles from "./LocalLockGate.module.css";

const LOCAL_LOCK_LABELS = {
  en: {
    continueOnline: "Continue online only",
    continueOnlineHint:
      "\"Continue online only\" keeps this device's locked offline edits sealed — they stay on this device and won't sync until you unlock them with the right passphrase.",
    description:
      "Offline data on this device is locked with a passphrase. Unlocking turns offline use and saving back on.",
    passphrasePlaceholder: "Passphrase",
    title: "Unlock local data",
    unlock: "Unlock",
    unsupportedBrowser: "Local lock isn't available in this browser.",
    wrongPassphrase: "That passphrase isn't right.",
  },
  ko: {
    continueOnline: "온라인 전용으로 계속",
    continueOnlineHint:
      "'온라인 전용으로 계속'을 선택하면 이 기기의 잠긴 오프라인 편집 내용은 봉인된 채 남아 있고, 올바른 암호로 잠금을 해제하기 전까지 동기화되지 않아요.",
    description:
      "이 기기의 오프라인 데이터가 암호로 잠겨 있어요. 잠금을 해제하면 오프라인 사용과 저장이 다시 활성화됩니다.",
    passphrasePlaceholder: "암호",
    title: "로컬 데이터 잠금 해제",
    unlock: "잠금 해제",
    unsupportedBrowser: "이 브라우저에서는 로컬 잠금을 사용할 수 없어요.",
    wrongPassphrase: "암호가 올바르지 않아요.",
  },
} as const;

function localLockLabels() {
  return pickLabels(LOCAL_LOCK_LABELS);
}

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
  const labels = localLockLabels();

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

  return (
    <div className={styles.backdrop} data-testid="local-lock-gate" role="dialog" aria-modal="true">
      <div className={styles.card}>
        <strong className={styles.title}>{labels.title}</strong>
        <p className={styles.desc}>{labels.description}</p>
        <input
          type="password"
          className={styles.input}
          data-testid="local-lock-passphrase"
          placeholder={labels.passphrasePlaceholder}
          value={passphrase}
          autoFocus
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void unlock();
          }}
        />
        {error ? (
          <p className={styles.error} data-testid="local-lock-error">
            {error === "wrong-passphrase" ? labels.wrongPassphrase : labels.unsupportedBrowser}
          </p>
        ) : null}
        {error === "wrong-passphrase" ? (
          <p className={styles.desc} data-testid="local-lock-continue-hint">
            {labels.continueOnlineHint}
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
            {labels.unlock}
          </button>
          <button
            type="button"
            className={styles.secondary}
            data-testid="local-lock-skip"
            onClick={skip}
          >
            {labels.continueOnline}
          </button>
        </div>
      </div>
    </div>
  );
}
