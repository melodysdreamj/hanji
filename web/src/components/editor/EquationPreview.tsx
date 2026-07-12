"use client";

import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { escapeHtml } from "./richtext";

function renderEquationHtml(expression: string): string {
  const src = expression.trim() || "E = mc^2";
  try {
    return katex.renderToString(src, {
      displayMode: true,
      throwOnError: false,
      errorColor: "var(--text-tertiary)",
    });
  } catch {
    return escapeHtml(src);
  }
}

export function EquationPreview({
  className,
  expression,
}: {
  className: string;
  expression: string;
}) {
  // KaTeX rendering is comparatively expensive; memoize on the source so
  // unrelated re-renders (parent state, selection changes) don't re-run it.
  const html = useMemo(() => renderEquationHtml(expression), [expression]);
  return (
    <div
      className={className}
      // KaTeX output is generated locally from the user's own LaTeX source
      // (no remote/untrusted HTML); throwOnError:false keeps it from throwing.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
