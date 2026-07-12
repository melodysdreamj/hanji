import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./editor.module.css";

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
  const diagramLabelId = `${renderId}-label`;
  const diagramSourceId = `${renderId}-source`;
  const { t } = useTranslation(["mermaidPreview", "common"]);
  const trimmedSource = source.trim();

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

  return (
    <div
      className={styles.mermaidPreview}
      contentEditable={false}
      aria-busy={!error && !svg && trimmedSource.length > 0}
    >
      {error ? (
        <div
          className={styles.mermaidError}
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <div className={styles.mermaidErrorMessage}>{t("mermaidPreview:syntaxError")}</div>
          <details className={styles.mermaidErrorDetails}>
            <summary>{t("mermaidPreview:syntaxErrorDetails")}</summary>
            <pre className={styles.mermaidErrorRaw}>{error}</pre>
          </details>
        </div>
      ) : svg ? (
        <div
          className={styles.mermaidDiagram}
          role="img"
          aria-labelledby={diagramLabelId}
          aria-describedby={diagramSourceId}
        >
          <span id={diagramLabelId} className={styles.srOnly}>
            {t("mermaidPreview:diagramLabel")}
          </span>
          <span id={diagramSourceId} className={styles.srOnly}>
            {t("mermaidPreview:sourceDescription", { source: trimmedSource })}
          </span>
          <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      ) : (
        <div className={styles.mermaidEmpty} role="status" aria-live="polite">
          {t("mermaidPreview:emptyPreview")}
        </div>
      )}
    </div>
  );
}
