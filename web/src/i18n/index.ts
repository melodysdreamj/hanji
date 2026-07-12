// react-i18next runtime setup.
//
// English (src/locales/en) is the SOURCE OF TRUTH; every other language is a
// translation catalog tracked against it (staleness detected by
// scripts/i18n-status.mjs). Namespace files are auto-discovered by each
// src/locales/<lang>.ts wrapper; the wrappers themselves are auto-discovered by
// the Vite glob below. Adding a namespace needs no runtime change. Adding a
// language needs its folder plus the same small wrapper used by en.ts/ko.ts so
// the whole catalog remains one lazy chunk instead of one request per namespace.
//
// Locale selection: an explicit in-app choice (WorkspaceSettingsDialog, stored
// under LANGUAGE_STORAGE_KEY) wins; otherwise the browser language decides, with
// English as the ultimate fallback. `@/lib/i18n isKoreanLocale()` reads back the
// resolved i18next language so dates follow the same (possibly overridden) choice.
import i18next, { type BackendModule, type ReadCallback } from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

type LanguageCatalogs = Record<string, Record<string, unknown>>;
type LanguageCatalogModule = { catalogs: LanguageCatalogs };

const languageModules = import.meta.glob<LanguageCatalogModule>("../locales/*.ts");
const languageLoaders = new Map<string, () => Promise<LanguageCatalogModule>>();
const languageLoadersByLower = new Map<string, () => Promise<LanguageCatalogModule>>();
for (const [path, loader] of Object.entries(languageModules)) {
  const language = /\/locales\/([^/]+)\.ts$/.exec(path)?.[1];
  if (language) {
    languageLoaders.set(language, loader);
    languageLoadersByLower.set(language.toLowerCase(), loader);
  }
}

const catalogPromises = new Map<string, Promise<LanguageCatalogs>>();
function loadLanguageCatalogs(language: string) {
  const lower = language.toLowerCase();
  const base = lower.split("-")[0];
  const cacheKey = languageLoadersByLower.has(lower) ? lower : base;
  const cached = catalogPromises.get(cacheKey);
  if (cached) return cached;
  const loader = languageLoadersByLower.get(lower) ?? languageLoadersByLower.get(base);
  const request: Promise<LanguageCatalogs> = loader
    ? loader().then((module) => module.catalogs)
    : Promise.resolve({} as LanguageCatalogs);
  catalogPromises.set(cacheKey, request);
  return request;
}

export const SUPPORTED_LANGUAGES = Array.from(languageLoaders.keys()).sort();
export const DEFAULT_NS = "common";

// An explicit in-app language choice is stored here (a language code) and takes
// precedence over the browser language; absent = follow the browser.
export const LANGUAGE_STORAGE_KEY = "hanji:language";

const resourceBackend: BackendModule = {
  type: "backend",
  init: () => {},
  read(language: string, namespace: string, callback: ReadCallback) {
    loadLanguageCatalogs(language)
      .then((catalogs) => callback(null, (catalogs[namespace] ?? {}) as Parameters<ReadCallback>[1]))
      .catch((error) => callback(error, false));
  },
};

export async function initI18n(): Promise<unknown> {
  const sourceCatalogs = await loadLanguageCatalogs("en");
  const namespaces = Object.keys(sourceCatalogs);
  return i18next
    .use(resourceBackend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      fallbackLng: "en",
      supportedLngs: SUPPORTED_LANGUAGES,
      // Preserve full codes (e.g. "zh-Hans", "pt-BR") so script/region variants
      // get their own catalog; nonExplicitSupportedLngs still maps "ko-KR" -> "ko".
      load: "currentOnly",
      nonExplicitSupportedLngs: true,
      ns: namespaces.length > 0 ? namespaces : [DEFAULT_NS],
      defaultNS: DEFAULT_NS,
      detection: {
        // Explicit choice (localStorage) wins; otherwise the browser decides.
        order: ["localStorage", "navigator", "htmlTag"],
        lookupLocalStorage: LANGUAGE_STORAGE_KEY,
        caches: [], // we persist the choice ourselves in setLanguagePreference
      },
      interpolation: { escapeValue: false },
      returnNull: false,
    });
}

// Keep <html lang> in sync with the active language (initial resolve + any
// manual switch) for CSS :lang() and accessibility.
if (typeof document !== "undefined") {
  i18next.on("languageChanged", (lng) => {
    try {
      document.documentElement.lang = lng;
    } catch {
      /* document may be unavailable in exotic contexts */
    }
  });
}

// ── Language preference API (for the in-app language selector) ──────────────
// "system" = follow the browser (no stored override); otherwise a language code.
export function resolveSupportedLanguage(
  requested: readonly string[],
  supported: readonly string[] = SUPPORTED_LANGUAGES,
): string {
  const supportedLower = new Map(supported.map((l) => [l.toLowerCase(), l]));
  for (const candidate of requested) {
    const lower = candidate.trim().toLowerCase();
    if (lower && supportedLower.has(lower)) return supportedLower.get(lower)!;
    const base = lower.split("-")[0];
    if (base && supportedLower.has(base)) return supportedLower.get(base)!;
  }
  return supportedLower.get("en") ?? (supported[0] ?? "en");
}

function browserLanguage(): string {
  if (typeof navigator === "undefined") return resolveSupportedLanguage(["en"]);
  const requested = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];
  return resolveSupportedLanguage(requested);
}

export function currentLanguagePreference(): string {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) return stored;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

export function setLanguagePreference(pref: string): void {
  let persisted = false;
  try {
    if (pref === "system") localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else localStorage.setItem(LANGUAGE_STORAGE_KEY, pref);
    persisted = true;
  } catch {
    /* storage unavailable */
  }
  // Reload so EVERY surface renders in the new language: many option/label
  // arrays bake their strings in at module-evaluation time and would not
  // re-localize on a live changeLanguage. The detection order re-reads the
  // stored choice on boot. If we couldn't persist, fall back to a live switch.
  if (persisted && typeof window !== "undefined") window.location.reload();
  else void i18next.changeLanguage(pref === "system" ? browserLanguage() : pref);
}

export { i18next };
