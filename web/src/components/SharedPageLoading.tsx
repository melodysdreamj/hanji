import { useTranslation } from "react-i18next";
import { TopBar } from "./TopBar";
import styles from "./PageView.module.css";

/**
 * Server-authoritative public shares never render cached content before the
 * access check. Keep this page-shaped fallback in the synchronous shell so a
 * deferred share-route chunk cannot introduce a blank frame.
 */
export function SharedPageLoading() {
  const { t } = useTranslation("sharedPageView");
  return (
    <>
      <TopBar title={t("title")} />
      <div className={styles.scroll}>
        <div
          className={styles.sharedLoading}
          aria-busy="true"
          aria-label={t("loading")}
          role="status"
        >
          <span className={styles.sharedLoadingTitle} />
          <span className={styles.sharedLoadingLine} />
          <span className={`${styles.sharedLoadingLine} ${styles.sharedLoadingLineShort}`} />
        </div>
      </div>
    </>
  );
}
