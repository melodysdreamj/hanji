import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchSponsorsRemote, type SponsorEntry } from "@/lib/edgebase";
import { BUILT_WITH, SPONSOR_CTA_URL, SPONSOR_SLOTS } from "@/lib/builtWith";
import styles from "./SupportSection.module.css";

// Settings → Preferences block that explains how the sponsor model works,
// shows the five sponsor slots (real sponsors + open placeholders), the
// "become a sponsor" CTA, and the honest built-with credits.
export function SupportSection() {
  const { t } = useTranslation(["sponsors", "common"]);
  const [sponsors, setSponsors] = useState<SponsorEntry[]>([]);

  useEffect(() => {
    let mounted = true;
    fetchSponsorsRemote().then((feed) => {
      if (mounted) setSponsors(feed.sponsors);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const slots = Array.from({ length: SPONSOR_SLOTS }, (_, i) => sponsors[i] ?? null);

  return (
    <div className={styles.support} data-testid="support-section">
      <div className={styles.title}>{t("sponsors:supportTitle")}</div>
      <p className={styles.intro}>{t("sponsors:settingsIntro")}</p>
      <ul className={styles.rules}>
        <li>{t("sponsors:rule1")}</li>
        <li>{t("sponsors:rule2")}</li>
        <li>{t("sponsors:rule3")}</li>
        <li>{t("sponsors:rule4")}</li>
      </ul>

      <div className={styles.subTitle}>{t("sponsors:sponsorSlots")}</div>
      <ol className={styles.slots}>
        {slots.map((sponsor, i) => (
          <li key={i} className={styles.slot} data-empty={sponsor ? undefined : "true"}>
            {sponsor ? (
              sponsor.url ? (
                <a href={sponsor.url} target="_blank" rel="noreferrer noopener">
                  {sponsor.name}
                </a>
              ) : (
                <span>{sponsor.name}</span>
              )
            ) : (
              <span className={styles.emptySlot}>{t("sponsors:emptySlot")}</span>
            )}
          </li>
        ))}
      </ol>
      <a
        className={styles.cta}
        href={SPONSOR_CTA_URL}
        target="_blank"
        rel="noreferrer noopener"
      >
        {t("sponsors:becomeSponsor")}
      </a>

      <div className={styles.subTitle}>{t("sponsors:builtWithTitle")}</div>
      <p className={styles.intro}>{t("sponsors:builtWithIntro")}</p>
      <ul className={styles.builtWithList}>
        {BUILT_WITH.map((entry) => (
          <li key={entry.name}>
            <a href={entry.url} target="_blank" rel="noreferrer noopener">
              {entry.name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
