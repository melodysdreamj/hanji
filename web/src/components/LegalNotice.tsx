import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_LEGAL_LINKS,
  fetchRuntimeConfigRemote,
  type LegalLinks,
} from "@/lib/edgebase";
import styles from "./LegalNotice.module.css";

export function LegalNotice({
  inline = false,
  alignStart = false,
}: {
  inline?: boolean;
  /** Left-align the inline notice to match a left-aligned column (e.g. sidebar footer). */
  alignStart?: boolean;
}) {
  const { t } = useTranslation("legalNotice");
  const [links, setLinks] = useState<LegalLinks>(DEFAULT_LEGAL_LINKS);

  useEffect(() => {
    let mounted = true;
    void fetchRuntimeConfigRemote().then((config) => {
      if (mounted) setLinks(config.legal);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <aside
      className={
        inline
          ? `${styles.inline}${alignStart ? ` ${styles.alignStart}` : ""}`
          : styles.notice
      }
      aria-label={t("ariaLabel")}
      data-testid="legal-notice"
    >
      <a href={links.sourceUrl} target="_blank" rel="noreferrer noopener">
        {t("sourceCode")}
      </a>
      <span aria-hidden="true" className={styles.separator}>·</span>
      <a href={links.agplLicenseUrl} target="_blank" rel="noreferrer noopener license">
        {t("agplLicense")}
      </a>
      <span aria-hidden="true" className={styles.separator}>·</span>
      <a href={links.sponsorExceptionUrl} target="_blank" rel="noreferrer noopener license">
        {t("sponsorException")}
      </a>
    </aside>
  );
}
