"use client";

import { useState } from "react";

import { isComposingKeyEvent } from "@/lib/keyboard";

export function parseNumberDraft(value: string): number | null | undefined {
  const normalized = value.trim().replace(/[,\s$€₩%]/g, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

export function NumberTextInput({
  value,
  onChange,
  className,
  placeholder = "Number",
  ariaLabel,
  disabled = false,
}: {
  value: unknown;
  onChange: (value: number | null) => void;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const source = value == null || value === "" ? "" : String(value);
  const [draftState, setDraftState] = useState({ source, draft: source });
  const draft = draftState.source === source ? draftState.draft : source;

  function setDraft(next: string) {
    setDraftState({ source, draft: next });
  }

  function commit(raw = draft) {
    const next = parseNumberDraft(raw);
    if (next === undefined) {
      setDraftState({ source, draft: source });
      return;
    }
    onChange(next);
    const nextSource = next == null ? "" : String(next);
    setDraftState({ source: nextSource, draft: nextSource });
  }

  return (
    <input
      className={className}
      type="text"
      inputMode="decimal"
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (isComposingKeyEvent(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setDraftState({ source, draft: source });
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}
