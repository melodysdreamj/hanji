"use client";

import { useTranslation } from "react-i18next";
import { isPageVerified } from "@/lib/pageVerification";
import type { Page } from "@/lib/types";
import { CheckIcon } from "./icons";
import styles from "./VerificationBadge.module.css";

export function VerificationBadge({
  page,
  compact = false,
}: {
  page: Page;
  compact?: boolean;
}) {
  const { t } = useTranslation("topBar");
  if (!isPageVerified(page)) return null;
  const label = t("verified");
  return (
    <span
      className={styles.badge}
      data-compact={compact ? "true" : undefined}
      data-page-verification-badge="true"
      title={label}
      aria-label={label}
    >
      <CheckIcon size={compact ? 11 : 12} aria-hidden="true" />
      {!compact && <span>{label}</span>}
    </span>
  );
}
