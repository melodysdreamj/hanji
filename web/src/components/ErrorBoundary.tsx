import { Component, type ReactNode } from "react";

import { i18next } from "@/i18n";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Where the boundary sits, for the console diagnostic. */
  scope: string;
  /** Root-level recovery reloads the bundle instead of repeating a broken tree. */
  reloadOnRetry?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
  reference: string;
}

function errorReference() {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `HJ-${Date.now().toString(36).toUpperCase()}-${random}`;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, reference: "" };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, reference: errorReference() };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(
      `[error-boundary:${this.props.scope}] [${this.state.reference}]`,
      error,
      info.componentStack ?? ""
    );
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          margin: "24px auto",
          maxWidth: 480,
          padding: "16px 20px",
          borderRadius: 8,
          border: "1px solid var(--color-border, rgba(128, 128, 128, 0.3))",
          color: "var(--color-text, inherit)",
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{i18next.t("errorBoundary:title")}</div>
        <div style={{ opacity: 0.7, marginBottom: 4 }}>
          {i18next.t("errorBoundary:detail")}
        </div>
        <div style={{ opacity: 0.55, marginBottom: 12, fontSize: 12 }}>
          {i18next.t("errorBoundary:reference", { reference: this.state.reference })}
        </div>
        <button
          type="button"
          onClick={() => {
            if (this.props.reloadOnRetry) {
              window.location.reload();
              return;
            }
            this.setState({ error: null, reference: "" });
          }}
          style={{
            padding: "4px 12px",
            borderRadius: 6,
            border: "1px solid var(--color-border, rgba(128, 128, 128, 0.4))",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          {this.props.reloadOnRetry
            ? i18next.t("errorBoundary:reload")
            : i18next.t("errorBoundary:retry")}
        </button>
      </div>
    );
  }
}
