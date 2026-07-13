"use client";

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { routeInfoFromPath, usePathname, useRouter, useSearchParams } from "@/lib/router";
import { AppShell } from "./AppShell";
import { ErrorBoundary } from "./ErrorBoundary";
import { TopBar } from "./TopBar";
import pageStyles from "./PageView.module.css";

const HomeView = lazy(() =>
  import("./HomeView").then(({ HomeView }) => ({ default: HomeView }))
);
const PageView = lazy(() => import("./PageView").then(({ PageView }) => ({ default: PageView })));
const SharedPageView = lazy(() =>
  import("./SharedPageView").then(({ SharedPageView }) => ({ default: SharedPageView }))
);
const TrashView = lazy(() => import("./TrashView").then(({ TrashView }) => ({ default: TrashView })));
const WorkspaceSettingsDialog = lazy(() =>
  import("./WorkspaceSettingsDialog").then(({ WorkspaceSettingsDialog }) => ({
    default: WorkspaceSettingsDialog,
  }))
);

function RouteFallback() {
  const { t } = useTranslation(["app", "common"]);
  return <div aria-busy="true" aria-label={t("app:loading")} style={{ minHeight: "100%" }} />;
}

function SettingsRouteView() {
  const searchParams = useSearchParams();
  const adminParam = searchParams.get("admin");
  const surfaceParam = searchParams.get("surface");
  const serverAdminSurface = adminParam === "server" || surfaceParam === "server-admin";
  const workspaceAdminSurface =
    adminParam === "1" ||
    adminParam === "workspace" ||
    surfaceParam === "admin" ||
    surfaceParam === "workspace-admin";

  if (serverAdminSurface) return <WorkspaceSettingsDialog surface="server-admin" />;
  if (workspaceAdminSurface) return <WorkspaceSettingsDialog surface="workspace-admin" />;
  return <WorkspaceSettingsDialog surface="account-console" />;
}

function RoutedView() {
  const pathname = usePathname();
  const route = routeInfoFromPath(pathname);

  if (route.kind === "trash") return <TrashView />;
  if (route.kind === "settings" || route.kind === "account") return <SettingsRouteView />;
  if (route.kind === "page") return <PageView pageId={route.pageId} />;
  if (route.kind === "database") return <PageView pageId={route.databaseId} />;
  if (route.kind === "share") return <SharedPageView token={route.shareId} />;
  if (route.kind === "home" || route.kind === "workspace") return <HomeView />;
  return (
    <RouteProblem
      kind={route.kind === "unknown" ? "not-found" : route.routeKind === "share" ? "shared" : "invalid"}
    />
  );
}

function RouteProblem({ kind }: { kind: "invalid" | "not-found" | "shared" }) {
  const { t } = useTranslation(["routeState", "common"]);
  const router = useRouter();
  const title =
    kind === "shared"
      ? t("routeState:sharedTitle")
      : kind === "not-found"
        ? t("routeState:notFoundTitle")
        : t("routeState:invalidTitle");
  const body =
    kind === "shared"
      ? t("routeState:sharedBody")
      : kind === "not-found"
        ? t("routeState:notFoundBody")
        : t("routeState:invalidBody");
  return (
    <>
      <TopBar title={title} />
      <div className={pageStyles.missing} data-surface="route-problem" role="status">
        <h1 className={pageStyles.missingHeading}>{title}</h1>
        <p>{body}</p>
        <div className={pageStyles.missingActions}>
          <button
            type="button"
            className={pageStyles.restoreButton}
            onClick={() => router.replace("/")}
          >
            {t("routeState:openHome")}
          </button>
        </div>
      </div>
    </>
  );
}

export default function AuthenticatedProduct() {
  const pathname = usePathname();
  return (
    <AppShell>
      <ErrorBoundary scope="route" key={pathname}>
        <Suspense fallback={<RouteFallback />}>
          <RoutedView />
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}
