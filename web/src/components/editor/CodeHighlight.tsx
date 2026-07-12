"use client";

import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import { escapeHtml } from "./richtext";
import "./codeTheme.css";

const HLJS_LANG_ALIAS: Record<string, string> = { html: "xml" };

function hljsLanguageFor(language: string): string | null {
  if (!language || language === "mermaid") return null;
  const id = HLJS_LANG_ALIAS[language] ?? language;
  return hljs.getLanguage(id) ? id : null;
}

export function CodeHighlight({ code, language }: { code: string; language: string }) {
  const html = useMemo(() => {
    const lang = hljsLanguageFor(language);
    if (!lang) return escapeHtml(code);
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, language]);

  return (
    <code
      className="hljs"
      // Highlighted HTML is produced locally by highlight.js from the user's own
      // code text (escaped); no untrusted markup is injected.
      dangerouslySetInnerHTML={{ __html: html || "&#8203;" }}
    />
  );
}
