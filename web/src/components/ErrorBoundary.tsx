import { Component, type ReactNode } from "react";

import { pickLabels } from "@/lib/i18n";

const ERROR_LABELS = {
  en: {
    title: "Something went wrong displaying this content.",
    detailPrefix: "Error",
    retry: "Try again",
  },
  ko: {
    title: "콘텐츠를 표시하는 중 문제가 발생했습니다.",
    detailPrefix: "오류",
    retry: "다시 시도",
  },
} as const;

function errorLabels() {
  return pickLabels(ERROR_LABELS);
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Where the boundary sits, for the console diagnostic. */
  scope: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[error-boundary:${this.props.scope}]`, error, info.componentStack ?? "");
  }

  render() {
    if (!this.state.error) return this.props.children;
    const labels = errorLabels();
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
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{labels.title}</div>
        <div style={{ opacity: 0.7, marginBottom: 12, wordBreak: "break-word" }}>
          {labels.detailPrefix}: {this.state.error.message}
        </div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
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
          {labels.retry}
        </button>
      </div>
    );
  }
}
