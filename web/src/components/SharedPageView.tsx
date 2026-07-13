"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSharedPageRemote } from "@/lib/edgebase";
import { useSearchParams } from "@/lib/router";
import { sharedPageErrorKind, type SharedPageErrorKind } from "@/lib/sharedPageErrors";
import { useStore } from "@/lib/store";
import { PageView } from "./PageView";
import { TopBar } from "./TopBar";
import styles from "./PageView.module.css";

type SharedPageState =
  | { status: "loading"; pageId?: undefined; error?: undefined }
  | { status: "ready"; rootPageId: string; pageIds: Set<string>; error?: undefined }
  | { status: "error"; pageId?: undefined; error: SharedPageErrorKind };

export function SharedPageView({ token }: { token: string }) {
  const { t } = useTranslation(["sharedPageView", "common"]);
  const applySharedPageSnapshot = useStore((s) => s.applySharedPageSnapshot);
  const searchParams = useSearchParams();
  const [state, setState] = useState<SharedPageState>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getSharedPageRemote(token)
      .then((snapshot) => {
        if (cancelled) return;
        applySharedPageSnapshot(snapshot, token);
        const fallbackPageIds = [snapshot.page.id, ...(snapshot.pages ?? []).map((page) => page.id)];
        setState({
          status: "ready",
          rootPageId: snapshot.page.id,
          pageIds: new Set(snapshot.navigablePageIds?.length ? snapshot.navigablePageIds : fallbackPageIds),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: sharedPageErrorKind(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [applySharedPageSnapshot, retryKey, token]);

  if (state.status === "loading") {
    return (
      <>
        <TopBar title={t("sharedPageView:title")} />
        <div className={styles.missing} aria-busy="true" aria-label={t("sharedPageView:loading")} />
      </>
    );
  }

  if (state.status === "error") {
    return (
      <>
        <TopBar title={t("sharedPageView:title")} />
        <div className={styles.missing} role="alert">
          <strong>{t("sharedPageView:unavailable")}</strong>
          <p>{t(`sharedPageView:errors.${state.error}`)}</p>
          <div className={styles.missingActions}>
            <button
              type="button"
              className={styles.restoreButton}
              onClick={() => {
                setState({ status: "loading" });
                setRetryKey((current) => current + 1);
              }}
            >
              {t("sharedPageView:tryAgain")}
            </button>
          </div>
        </div>
      </>
    );
  }

  const requestedPageId = searchParams.get("page") || state.rootPageId;
  if (!state.pageIds.has(requestedPageId)) {
    return (
      <>
        <TopBar title={t("sharedPageView:title")} />
        <div className={styles.missing}>
          <strong>{t("sharedPageView:unavailable")}</strong>
          <p>{t("sharedPageView:outsideShare")}</p>
        </div>
      </>
    );
  }

  return <PageView pageId={requestedPageId} publicReadOnly sharedToken={token} />;
}
