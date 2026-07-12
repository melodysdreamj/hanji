"use client";

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useParams, usePathname, useSearchParams } from "@/lib/router";
import { AppShell } from "./AppShell";
import { ErrorBoundary } from "./ErrorBoundary";

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
  const params = useParams();

  if (pathname === "/trash") return <TrashView />;
  if (pathname === "/settings" || pathname === "/account") return <SettingsRouteView />;
  if (params.pageId) return <PageView pageId={params.pageId} />;
  if (params.databaseId) return <PageView pageId={params.databaseId} />;
  if (params.shareId) return <SharedPageView token={params.shareId} />;
  return <HomeView />;
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
