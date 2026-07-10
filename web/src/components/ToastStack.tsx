"use client";

import { useStore } from "@/lib/store";
import { pickLabels } from "@/lib/i18n";
import styles from "./ToastStack.module.css";

const TOAST_LABELS = {
  en: { dismiss: "Dismiss notification" },
  ko: { dismiss: "알림 닫기" },
} as const;

export function ToastStack() {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const labels = pickLabels(TOAST_LABELS);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.stack} role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => {
        const hasAction = !!toast.action;
        return (
          <div
            key={toast.id}
            className={styles.toast}
            data-tone={toast.tone ?? "default"}
            role={hasAction ? undefined : "button"}
            tabIndex={hasAction ? undefined : 0}
            onClick={hasAction ? undefined : () => dismissToast(toast.id)}
            onKeyDown={(e) => {
              if (hasAction || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              dismissToast(toast.id);
            }}
          >
            <span className={styles.message}>{toast.message}</span>
            {toast.action && (
              <>
                <button
                  type="button"
                  className={styles.action}
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissToast(toast.id);
                    void Promise.resolve(toast.action?.onClick()).catch(() => undefined);
                  }}
                >
                  {toast.action.label}
                </button>
                <button
                  type="button"
                  className={styles.dismiss}
                  aria-label={labels.dismiss}
                  onClick={(event) => {
                    event.stopPropagation();
                    dismissToast(toast.id);
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
