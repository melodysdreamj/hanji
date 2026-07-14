import { AuthGate } from "@/components/AuthGate";
import AuthenticatedProduct from "@/components/AuthenticatedProduct";
import { ErrorBoundary } from "@/components/ErrorBoundary";

function ProductApp() {
  return (
    <AuthGate>
      <AuthenticatedProduct />
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
