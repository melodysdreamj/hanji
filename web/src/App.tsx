import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { AuthGate } from "@/components/AuthGate";
import { ErrorBoundary } from "@/components/ErrorBoundary";
const AuthenticatedProduct = lazy(() => import("@/components/AuthenticatedProduct"));

function RouteFallback() {
  const { t } = useTranslation(["app", "common"]);
  return <div aria-busy="true" aria-label={t("app:loading")} style={{ minHeight: "100%" }} />;
}

function ProductApp() {
  return (
    <AuthGate>
      <Suspense fallback={<RouteFallback />}>
        <AuthenticatedProduct />
      </Suspense>
    </AuthGate>
  );
}

export function App() {
  return (
    <ErrorBoundary scope="root" reloadOnRetry>
      <ProductApp />
    </ErrorBoundary>
  );
}
