import { useEffect, useId, useState } from "react";
import { pickLabels } from "@/lib/i18n";
import styles from "./editor.module.css";

const MERMAID_PREVIEW_LABELS = {
  en: {
    emptyPreview: "Diagram preview",
    syntaxError: "The diagram has a syntax error.",
    syntaxErrorDetails: "Show details",
  },
  ko: {
    emptyPreview: "다이어그램 미리보기",
    syntaxError: "다이어그램에 문법 오류가 있어요.",
    syntaxErrorDetails: "자세히 보기",
  },
} as const;

let mermaidModule: typeof import("mermaid").default | null = null;
let mermaidInitTheme: "dark" | "default" | null = null;

async function ensureMermaid(theme: "dark" | "default") {
  if (!mermaidModule) {
    mermaidModule = (await import("mermaid")).default;
  }
  if (mermaidInitTheme !== theme) {
    mermaidModule.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
    mermaidInitTheme = theme;
  }
  return mermaidModule;
}

function currentMermaidTheme(): "dark" | "default" {
  if (typeof document === "undefined") return "default";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

export function MermaidPreview({ source, blockId }: { source: string; blockId: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "default">(() => currentMermaidTheme());
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(currentMermaidTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const trimmed = source.trim();
    const timer = window.setTimeout(() => {
      if (!trimmed) {
        if (cancelled) return;
        setSvg(null);
        setError(null);
        return;
      }
      const uid = `mermaid-${blockId}-${renderId}-${Date.now()}`;
      ensureMermaid(theme)
        .then((mermaid) => mermaid.render(uid, trimmed))
        .then(({ svg: out }) => {
          if (cancelled) return;
          setSvg(out);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          document.getElementById(uid)?.remove();
          document.querySelector(`#d${uid}`)?.remove();
          setSvg(null);
          setError(err instanceof Error ? err.message : String(err));
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, theme, blockId, renderId]);

  const labels = pickLabels(MERMAID_PREVIEW_LABELS);
  return (
    <div className={styles.mermaidPreview} contentEditable={false} aria-hidden="true">
      {error ? (
        <div className={styles.mermaidError}>
          <div className={styles.mermaidErrorMessage}>{labels.syntaxError}</div>
          <details className={styles.mermaidErrorDetails}>
            <summary>{labels.syntaxErrorDetails}</summary>
            <pre className={styles.mermaidErrorRaw}>{error}</pre>
          </details>
        </div>
      ) : svg ? (
        <div className={styles.mermaidDiagram} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className={styles.mermaidEmpty}>{labels.emptyPreview}</div>
      )}
    </div>
  );
}
