import { lazy, Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { AuthGate } from "@/components/AuthGate";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { HomeView } from "@/components/HomeView";
import { useParams, usePathname, useSearchParams } from "@/lib/router";

const PageView = lazy(() => import("@/components/PageView").then(({ PageView }) => ({ default: PageView })));
const SharedPageView = lazy(() =>
  import("@/components/SharedPageView").then(({ SharedPageView }) => ({ default: SharedPageView }))
);
const TrashView = lazy(() => import("@/components/TrashView").then(({ TrashView }) => ({ default: TrashView })));
const WorkspaceSettingsDialog = lazy(() =>
  import("@/components/WorkspaceSettingsDialog").then(({ WorkspaceSettingsDialog }) => ({
    default: WorkspaceSettingsDialog,
  }))
);

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

  if (serverAdminSurface) {
    return <WorkspaceSettingsDialog surface="server-admin" />;
  }

  if (workspaceAdminSurface) {
    return <WorkspaceSettingsDialog surface="workspace-admin" />;
  }

  return <WorkspaceSettingsDialog surface="account-console" />;
}

function RouteFallback() {
  return <div aria-busy="true" aria-label="Loading" style={{ minHeight: "100%" }} />;
}

function RoutedView() {
  const pathname = usePathname();
  const params = useParams();

  if (pathname === "/trash") return <TrashView />;
  if (pathname === "/settings" || pathname === "/account") return <SettingsRouteView />;
  if (params.pageId) return <PageView pageId={params.pageId} />;
  if (params.databaseId) return <PageView pageId={params.databaseId} />;
  if (params.shareId) return <SharedPageView token={params.shareId} />;
  if (params.workspaceSlug) return <HomeView />;

  return <HomeView />;
}

export function App() {
  const pathname = usePathname();
  return (
    <AuthGate>
      <AppShell>
        <ErrorBoundary scope="route" key={pathname}>
          <Suspense fallback={<RouteFallback />}>
            <RoutedView />
          </Suspense>
        </ErrorBoundary>
      </AppShell>
    </AuthGate>
  );
}
