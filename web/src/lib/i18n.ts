// Single home for UI locale resolution. Components keep their own label
// dictionaries (smoke tests and contracts assert the literal strings), but the
// locale decision itself must not be re-implemented per component.
import i18next from "i18next";

export function isKoreanLocale(): boolean {
  // Follow the RESOLVED i18next language so date formatting matches the active
  // UI language, including an explicit in-app override (see @/i18n). Fall back
  // to the browser before i18next has initialized.
  const lng = i18next.resolvedLanguage || i18next.language;
  if (lng) return lng.toLowerCase().startsWith("ko");
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ko");
}

export function pickLabels<E, K>(labels: { en: E; ko: K }): E | K {
  return isKoreanLocale() ? labels.ko : labels.en;
}

// BCP-47 locale for DISPLAY-ONLY Intl formatting. It follows the in-app
// language preference rather than the browser/OS locale, so dates, numbers,
// and currencies do not switch language underneath otherwise translated UI.
export function activeIntlLocale(): string {
  return isKoreanLocale() ? "ko-KR" : "en-US";
}

export function activeDateLocale(): string {
  return activeIntlLocale();
}

export function activeNumberLocale(): string {
  return activeIntlLocale();
}
