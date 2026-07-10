"use client";

import { useState } from "react";

import { isComposingKeyEvent } from "@/lib/keyboard";

import { dateKey, formatDateInput, parseDate, parseDateDraft } from "./dateUtils";

export function DateTextInput({
  value,
  onChange,
  className,
  placeholder = "Date",
  ariaLabel,
  disabled = false,
}: {
  value: unknown;
  onChange: (value: string | null) => void;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const parsed = parseDate(value);
  const formatted = formatDateInput(parsed);
  const [draftState, setDraftState] = useState({ source: formatted, draft: formatted });
  const draft = draftState.source === formatted ? draftState.draft : formatted;

  function setDraft(next: string) {
    setDraftState({ source: formatted, draft: next });
  }

  function commit(raw = draft) {
    if (!raw.trim()) {
      onChange(null);
      setDraftState({ source: "", draft: "" });
      return;
    }
    const next = parseDateDraft(raw, parsed?.getFullYear());
    if (!next) {
      setDraft(formatted);
      return;
    }
    onChange(dateKey(next));
    const nextFormatted = formatDateInput(next);
    setDraftState({ source: nextFormatted, draft: nextFormatted });
  }

  return (
    <input
      className={className}
      type="text"
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
          setDraft(formatted);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}
