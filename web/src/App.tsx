import { AuthGate } from "@/components/AuthGate";
import AuthenticatedProduct from "@/components/AuthenticatedProduct";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { InitialAuthRestore } from "@/lib/appStartup";

function ProductApp({ initialAuthRestore }: { initialAuthRestore?: InitialAuthRestore }) {
  return (
    <AuthGate initialAuthRestore={initialAuthRestore}>
      <AuthenticatedProduct />
    </AuthGate>
  );
}

export function App({ initialAuthRestore }: { initialAuthRestore?: InitialAuthRestore }) {
  return (
    <ErrorBoundary scope="root" reloadOnRetry>
      <ProductApp initialAuthRestore={initialAuthRestore} />
    </ErrorBoundary>
  );
}
