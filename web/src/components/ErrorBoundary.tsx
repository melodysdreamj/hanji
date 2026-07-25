import { Component, type ReactNode } from "react";

import { i18next } from "@/i18n";
import { createErrorReference, errorReportUrl } from "@/lib/errorReport";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Where the boundary sits, for the console diagnostic. */
  scope: string;
  /** Root-level recovery reloads the bundle instead of repeating a broken tree. */
  reloadOnRetry?: boolean;
  /** Deterministic runtime seams for the bounded dynamic-chunk recovery guard. */
  chunkRecoveryRuntime?: {
    importModule?: (url: string) => Promise<unknown>;
    reload?: () => void;
    sessionStorage?: Pick<Storage, "getItem" | "setItem">;
  };
}

interface ErrorBoundaryState {
  error: Error | null;
  reference: string;
}

const CHUNK_RECOVERY_STORAGE_KEY = "hanji:chunk-recovery:v1";
const CHUNK_RECOVERY_HISTORY_LIMIT = 16;
const inFlightChunkRecoveries = new Map<string, Promise<void>>();

function recoverableChunkUrl(error: Error): URL | null {
  if (typeof window === "undefined") return null;
  const candidates = error.message.match(/https?:\/\/[^\s"'<>]+/giu) ?? [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/u, ""));
      if (
        url.origin === window.location.origin &&
        url.pathname.startsWith("/assets/") &&
        url.pathname.endsWith(".js")
      ) {
        return url;
      }
    } catch {
      // A malformed token is not a recoverable same-origin chunk identity.
    }
  }
  return null;
}

function claimChunkRecovery(
  storage: Pick<Storage, "getItem" | "setItem">,
  chunkPath: string,
): boolean {
  try {
    const parsed = JSON.parse(storage.getItem(CHUNK_RECOVERY_STORAGE_KEY) ?? "[]");
    const history = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
    if (history.includes(chunkPath)) return false;
    storage.setItem(
      CHUNK_RECOVERY_STORAGE_KEY,
      JSON.stringify([...history, chunkPath].slice(-CHUNK_RECOVERY_HISTORY_LIMIT)),
    );
    return true;
  } catch {
    // Without durable same-tab state, reloading could turn recovery into a loop.
    return false;
  }
}

function defaultChunkImport(url: string) {
  return import(/* @vite-ignore */ url);
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, reference: "" };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, reference: createErrorReference() };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(
      `[error-boundary:${this.props.scope}] [${this.state.reference}]`,
      error,
      info.componentStack ?? ""
    );
    this.recoverChunkOnce(error);
  }

  private recoverChunkOnce(error: Error) {
    const chunkUrl = recoverableChunkUrl(error);
    if (!chunkUrl || typeof window === "undefined") return;

    const runtime = this.props.chunkRecoveryRuntime;
    let storage: Pick<Storage, "getItem" | "setItem">;
    try {
      storage = runtime?.sessionStorage ?? window.sessionStorage;
    } catch {
      return;
    }
    const chunkPath = chunkUrl.pathname;
    if (inFlightChunkRecoveries.has(chunkPath)) return;
    if (!claimChunkRecovery(storage, chunkPath)) {
      console.error(
        `[error-boundary:${this.props.scope}] chunk recovery exhausted for ${chunkPath} after one retry`,
        error,
      );
      return;
    }
    const retryUrl = new URL(chunkUrl);
    retryUrl.searchParams.set("__hanji_chunk_retry", "1");
    const importModule = runtime?.importModule ?? defaultChunkImport;
    const recovery = importModule(retryUrl.href).then(() => undefined);
    inFlightChunkRecoveries.set(chunkPath, recovery);

    void recovery
      .then(() => {
        const reload = runtime?.reload ?? (() => window.location.reload());
        reload();
      })
      .catch((recoveryError: unknown) => {
        console.error(
          `[error-boundary:${this.props.scope}] chunk recovery exhausted for ${chunkPath} after one retry`,
          recoveryError,
        );
      })
      .finally(() => {
        if (inFlightChunkRecoveries.get(chunkPath) === recovery) {
          inFlightChunkRecoveries.delete(chunkPath);
        }
      });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const reportHref = errorReportUrl({
      errorClass: "render-crash",
      pathname: typeof window === "undefined" ? "" : window.location.pathname,
      reference: this.state.reference,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    });
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
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
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
          <a
            href={reportHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "4px 12px",
              borderRadius: 6,
              color: "inherit",
              fontSize: 13,
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {i18next.t("common:actions.reportIssue")}
          </a>
        </div>
      </div>
    );
  }
}
