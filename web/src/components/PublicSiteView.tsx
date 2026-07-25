"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, X } from "./icons";
import { useTranslation } from "react-i18next";
import { getPublicSiteRemote, type PublicSiteResult } from "@/lib/edgebase";
import {
  createErrorReference,
  errorReportUrl,
  errorStatus,
  type ErrorReportClass,
} from "@/lib/errorReport";
import { markAppInteractiveForOfflineWarm } from "@/lib/appInteractive";
import { siteNavigationToken } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { useRouter, useSearchParams } from "@/lib/router";
import { sharedPageErrorKind, type SharedPageErrorKind } from "@/lib/sharedPageErrors";
import { useStore } from "@/lib/store";
import { PageView } from "./PageView";
import { SharedPageLoading } from "./SharedPageLoading";
import styles from "./PublicSiteView.module.css";

type PublicSiteState =
  | { status: "loading" }
  | { status: "ready"; snapshot: PublicSiteResult; pageIds: Set<string> }
  | { status: "error"; error: SharedPageErrorKind; httpStatus: number | null };

function reportLink(
  errorClass: ErrorReportClass,
  reference: string,
  status?: number | null,
) {
  return errorReportUrl({
    errorClass,
    pathname: typeof window === "undefined" ? "" : window.location.pathname,
    reference,
    status,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  });
}

export function PublicSiteView({
  slug,
  onRootSiteNotFound,
}: {
  slug?: string;
  onRootSiteNotFound?: () => void;
}) {
  const { t } = useTranslation(["publicSiteView", "common"]);
  const applySharedPageSnapshot = useStore((state) => state.applySharedPageSnapshot);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<PublicSiteState>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const reportReference = useMemo(createErrorReference, [retryKey, slug]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getPublicSiteRemote(slug)
      .then((snapshot) => {
        if (cancelled) return;
        applySharedPageSnapshot(snapshot, `site:${snapshot.site.id}`);
        const fallbackPageIds = [snapshot.page.id, ...(snapshot.pages ?? []).map((page) => page.id)];
        setState({
          status: "ready",
          snapshot,
          pageIds: new Set(snapshot.navigablePageIds?.length ? snapshot.navigablePageIds : fallbackPageIds),
        });
        markAppInteractiveForOfflineWarm();
      })
      .catch((error) => {
        if (cancelled) return;
        const errorKind = sharedPageErrorKind(error);
        if (!slug && errorKind === "not-found" && onRootSiteNotFound) {
          onRootSiteNotFound();
          return;
        }
        setState({ status: "error", error: errorKind, httpStatus: errorStatus(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [applySharedPageSnapshot, onRootSiteNotFound, retryKey, slug]);

  const snapshot = state.status === "ready" ? state.snapshot : null;
  const searchPages = useMemo(() => {
    if (!snapshot) return [];
    const allowed = new Set(snapshot.navigablePageIds ?? []);
    const query = searchQuery.trim().toLocaleLowerCase();
    return [snapshot.page, ...(snapshot.pages ?? [])]
      .filter((page, index, all) => allowed.has(page.id) && all.findIndex((item) => item.id === page.id) === index)
      .filter((page) => !query || pageDisplayTitle(page).toLocaleLowerCase().includes(query))
      .slice(0, 12);
  }, [searchQuery, snapshot]);

  if (state.status === "loading") return <SharedPageLoading />;

  if (state.status === "error") {
    return (
      <div className={styles.error} role="alert">
        <strong>{t("publicSiteView:unavailable")}</strong>
        <p>{t(`publicSiteView:errors.${state.error}`)}</p>
        <div className={styles.errorActions}>
          <button type="button" onClick={() => setRetryKey((current) => current + 1)}>
            {t("publicSiteView:tryAgain")}
          </button>
          <a
            href={reportLink(`site-${state.error}`, reportReference, state.httpStatus)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("common:actions.reportIssue")}
          </a>
        </div>
      </div>
    );
  }

  const { site } = state.snapshot;
  const requestedPageId = searchParams.get("page") || state.snapshot.page.id;
  if (!state.pageIds.has(requestedPageId)) {
    return (
      <div className={styles.error} role="alert">
        <strong>{t("publicSiteView:unavailable")}</strong>
        <p>{t("publicSiteView:outsideSite")}</p>
        <a
          href={reportLink("site-outside-graph", reportReference)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("common:actions.reportIssue")}
        </a>
      </div>
    );
  }
  const activePage = [state.snapshot.page, ...(state.snapshot.pages ?? [])]
    .find((page) => page.id === requestedPageId);
  const basePath = slug ? `/site/${encodeURIComponent(slug)}` : "/";
  const navigationToken = siteNavigationToken(basePath);
  const openPage = (pageId: string) => {
    const params = new URLSearchParams();
    if (pageId !== state.snapshot.page.id) params.set("page", pageId);
    router.push(params.size ? `${basePath}?${params}` : basePath);
    setSearchQuery("");
  };
  const navigationPages = site.navigationPageIds
    .map((pageId) => [state.snapshot.page, ...(state.snapshot.pages ?? [])].find((page) => page.id === pageId))
    .filter((page): page is NonNullable<typeof page> => Boolean(page));

  return (
    <section
      className={styles.site}
      data-site-theme={site.theme}
      data-theme={site.theme === "system" ? undefined : site.theme}
      data-site-slug={site.slug}
    >
      <header className={styles.header}>
        <button type="button" className={styles.identity} onClick={() => openPage(state.snapshot.page.id)}>
          <span className={styles.mark} aria-hidden="true">{site.title.slice(0, 1).toUpperCase()}</span>
          <span>{site.title}</span>
        </button>
        <nav className={styles.navigation} aria-label={t("publicSiteView:navigation")}>
          {navigationPages.map((page) => (
            <button
              key={page.id}
              type="button"
              data-active={page.id === requestedPageId ? "true" : undefined}
              onClick={() => openPage(page.id)}
            >
              {pageDisplayTitle(page)}
            </button>
          ))}
        </nav>
        {site.showSearch && (
          <div className={styles.search}>
            <Search size={16} aria-hidden="true" />
            <input
              value={searchQuery}
              aria-label={t("publicSiteView:search")}
              placeholder={t("publicSiteView:search")}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
            />
            {searchQuery && (
              <button type="button" aria-label={t("publicSiteView:clearSearch")} onClick={() => setSearchQuery("")}>
                <X size={14} aria-hidden="true" />
              </button>
            )}
            {searchQuery && (
              <div className={styles.searchResults}>
                {searchPages.length ? searchPages.map((page) => (
                  <button key={page.id} type="button" onClick={() => openPage(page.id)}>
                    {pageDisplayTitle(page)}
                  </button>
                )) : <span>{t("publicSiteView:noResults")}</span>}
              </div>
            )}
          </div>
        )}
      </header>
      {site.showBreadcrumbs && (
        <div className={styles.breadcrumbs} aria-label={t("publicSiteView:breadcrumbs")}>
          <button type="button" onClick={() => openPage(state.snapshot.page.id)}>{site.title}</button>
          {requestedPageId !== state.snapshot.page.id && <span>/</span>}
          {requestedPageId !== state.snapshot.page.id && <span>{activePage ? pageDisplayTitle(activePage) : ""}</span>}
        </div>
      )}
      <main className={styles.content}>
        <PageView pageId={requestedPageId} publicReadOnly sharedToken={navigationToken} hideTopBar />
      </main>
      {site.showBranding && <footer className={styles.branding}>{t("publicSiteView:madeWithHanji")}</footer>}
    </section>
  );
}
