// Single home for UI locale resolution. Components keep their own label
// dictionaries (smoke tests and contracts assert the literal strings), but the
// locale decision itself must not be re-implemented per component.
export function isKoreanLocale(): boolean {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ko");
}

export function pickLabels<E, K>(labels: { en: E; ko: K }): E | K {
  return isKoreanLocale() ? labels.ko : labels.en;
}

// BCP-47 locale for DISPLAY-ONLY date/time formatting (Intl / toLocaleString).
// This controls month names, ordering, and 12/24h presentation for the active
// UI language — it never changes the underlying date VALUE or its timezone.
export function activeDateLocale(): string {
  return isKoreanLocale() ? "ko-KR" : "en-US";
}
