"use client";

import { useTranslation } from "react-i18next";
import { loginRoll } from "@/lib/builtWith";
import { useCreditRoll } from "@/lib/useCreditRoll";
import { CreditLine } from "./CreditLine";
import styles from "./ProductLoadingScreen.module.css";

/**
 * Minimal first-visit fallback. Returning users normally hydrate their cached
 * workspace before the deferred variant becomes visible, so a routine reload
 * does not flash product branding or a spinner over the local render.
 */
export function ProductLoadingScreen({
  deferred = false,
  source,
}: {
  deferred?: boolean;
  source: "auth" | "workspace";
}) {
  const { t } = useTranslation(["app", "common"]);
  const slot = useCreditRoll({ build: loginRoll });

  return (
    <main
      className={`${styles.screen}${deferred ? ` ${styles.deferred}` : ""}`}
      data-testid="product-loading-screen"
      data-source={source}
      aria-busy="true"
      aria-label={t("app:loading")}
      role="status"
    >
      <div className={styles.content}>
        <img
          className={styles.mark}
          src="/icon-192.png"
          alt=""
          aria-hidden="true"
          width="48"
          height="48"
          fetchPriority="high"
          data-testid="product-loading-mark"
        />
        {slot ? (
          <p className={styles.credit} data-testid="product-loading-credit" data-kind={slot.kind}>
            <CreditLine slot={slot} />
          </p>
        ) : null}
      </div>
    </main>
  );
}
