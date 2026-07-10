"use client";

import { useEffect, useState } from "react";
import { getSharedPageRemote } from "@/lib/edgebase";
import { pickLabels } from "@/lib/i18n";
import { useSearchParams } from "@/lib/router";
import { useStore } from "@/lib/store";
import { PageView } from "./PageView";
import { TopBar } from "./TopBar";
import styles from "./PageView.module.css";

const SHARED_PAGE_LABELS = {
  en: {
    title: "Shared page",
    loading: "Loading shared page",
    unavailable: "This shared page is unavailable.",
    notFound: "Shared page was not found.",
    outsideShare: "The page is not part of this public share.",
  },
  ko: {
    title: "공유 페이지",
    loading: "공유 페이지 불러오는 중",
    unavailable: "이 공유 페이지를 사용할 수 없습니다.",
    notFound: "공유 페이지를 찾을 수 없습니다.",
    outsideShare: "이 페이지는 공개 공유 범위에 포함되지 않습니다.",
  },
} as const;

type SharedPageState =
  | { status: "loading"; pageId?: undefined; error?: undefined }
  | { status: "ready"; rootPageId: string; pageIds: Set<string>; error?: undefined }
  | { status: "error"; pageId?: undefined; error: string };

export function SharedPageView({ token }: { token: string }) {
  const labels = pickLabels(SHARED_PAGE_LABELS);
  const applySharedPageSnapshot = useStore((s) => s.applySharedPageSnapshot);
  const searchParams = useSearchParams();
  const [state, setState] = useState<SharedPageState>({ status: "loading" });

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
          error: error instanceof Error ? error.message : labels.notFound,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [applySharedPageSnapshot, labels.notFound, token]);

  if (state.status === "loading") {
    return (
      <>
        <TopBar title={labels.title} />
        <div className={styles.missing} aria-busy="true" aria-label={labels.loading} />
      </>
    );
  }

  if (state.status === "error") {
    return (
      <>
        <TopBar title={labels.title} />
        <div className={styles.missing}>
          <strong>{labels.unavailable}</strong>
          <p>{state.error}</p>
        </div>
      </>
    );
  }

  const requestedPageId = searchParams.get("page") || state.rootPageId;
  if (!state.pageIds.has(requestedPageId)) {
    return (
      <>
        <TopBar title={labels.title} />
        <div className={styles.missing}>
          <strong>{labels.unavailable}</strong>
          <p>{labels.outsideShare}</p>
        </div>
      </>
    );
  }

  return <PageView pageId={requestedPageId} publicReadOnly sharedToken={token} />;
}
