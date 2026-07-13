// react-i18next runtime setup.
//
// English (src/locales/en) is the SOURCE OF TRUTH; every other language is a
// translation catalog tracked against it (staleness detected by
// scripts/i18n-status.mjs). Namespace files are auto-discovered by each
// src/locales/<lang>.ts wrapper; the wrappers themselves are auto-discovered by
// the Vite glob below. Adding a namespace needs no runtime change. Translation
// target wrappers may exist before a language is released in the selector.
//
// Locale selection: an explicit in-app choice (WorkspaceSettingsDialog, stored
// under LANGUAGE_STORAGE_KEY) wins; otherwise the browser language decides, with
// English as the ultimate fallback. Browser tags are normalized to a released
// catalog before i18next starts so script/region variants remain intact.
import i18next, { type BackendModule, type ReadCallback } from "i18next";
import { initReactI18next } from "react-i18next";
import { LANGUAGE_OPTIONS } from "./languages";

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

export const SUPPORTED_LANGUAGES = LANGUAGE_OPTIONS.map((option) => option.value);
export const DEFAULT_NS = "common";

// An explicit in-app language choice is stored here (a language code) and takes
// precedence over the browser language; absent = follow the browser.
export const LANGUAGE_STORAGE_KEY = "hanji:language";

function canonicalLanguageTag(language: string): string {
  const normalized = language.trim().replaceAll("_", "-");
  if (!normalized) return "";
  try {
    return Intl.getCanonicalLocales(normalized)[0] ?? normalized;
  } catch {
    return normalized;
  }
}

function supportedLanguageForCandidate(
  candidate: string,
  supportedLower: ReadonlyMap<string, string>,
): string | undefined {
  const canonical = canonicalLanguageTag(candidate);
  const lower = canonical.toLowerCase();
  if (!lower) return undefined;

  const exact = supportedLower.get(lower);
  if (exact) return exact;

  const [base, ...subtags] = lower.split("-");
  if (base === "zh") {
    const traditional = subtags.includes("hant") || subtags.some((part) =>
      part === "tw" || part === "hk" || part === "mo"
    );
    if (traditional) {
      // Do not silently show Simplified Chinese to Traditional Chinese users.
      // Until zh-Hant is released, continue to the next requested language and
      // ultimately use English.
      return supportedLower.get("zh-hant");
    }
    return supportedLower.get("zh-hans");
  }

  if (base === "pt" && subtags.length === 0) {
    return supportedLower.get("pt-br") ?? supportedLower.get("pt");
  }

  return supportedLower.get(base);
}

export function resolveSupportedLanguage(
  requested: readonly string[],
  supported: readonly string[] = SUPPORTED_LANGUAGES,
): string {
  const supportedLower = new Map(supported.map((language) => [language.toLowerCase(), language]));
  for (const candidate of requested) {
    const resolved = supportedLanguageForCandidate(candidate, supportedLower);
    if (resolved) return resolved;
  }
  return supportedLower.get("en") ?? (supported[0] ?? "en");
}

const catalogPromises = new Map<string, Promise<LanguageCatalogs>>();
function loadLanguageCatalogs(language: string) {
  const resolved = resolveSupportedLanguage([language]);
  const cacheKey = resolved.toLowerCase();
  const cached = catalogPromises.get(cacheKey);
  if (cached) return cached;
  const loader = languageLoadersByLower.get(cacheKey);
  const request: Promise<LanguageCatalogs> = loader
    ? loader().then((module) => module.catalogs)
    : Promise.resolve({} as LanguageCatalogs);
  catalogPromises.set(cacheKey, request);
  return request;
}

function storedLanguage(): string | undefined {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (!stored) return undefined;
    const supportedLower = new Map(
      SUPPORTED_LANGUAGES.map((language) => [language.toLowerCase(), language]),
    );
    return supportedLanguageForCandidate(stored, supportedLower);
  } catch {
    return undefined;
  }
}

function browserLanguage(): string {
  const requested: string[] = [];
  if (typeof navigator !== "undefined") {
    if (Array.isArray(navigator.languages)) requested.push(...navigator.languages);
    if (navigator.language) requested.push(navigator.language);
  }
  if (typeof document !== "undefined" && document.documentElement.lang) {
    requested.push(document.documentElement.lang);
  }
  return resolveSupportedLanguage(requested.length > 0 ? requested : ["en"]);
}

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
    .use(initReactI18next)
    .init({
      lng: storedLanguage() ?? browserLanguage(),
      fallbackLng: "en",
      supportedLngs: SUPPORTED_LANGUAGES,
      // Detection is normalized before init so full script/region codes use
      // the intended released catalog instead of being reduced to a base code.
      load: "currentOnly",
      nonExplicitSupportedLngs: false,
      ns: namespaces.length > 0 ? namespaces : [DEFAULT_NS],
      defaultNS: DEFAULT_NS,
      interpolation: { escapeValue: false },
      returnNull: false,
    });
}

const RTL_LANGUAGE_BASES = new Set(["ar", "dv", "fa", "he", "ku", "ps", "ur", "yi"]);

export function documentDirectionForLanguage(language: string): "ltr" | "rtl" {
  const base = canonicalLanguageTag(language).toLowerCase().split("-")[0];
  return RTL_LANGUAGE_BASES.has(base) ? "rtl" : "ltr";
}

export function syncDocumentLanguage(language: string): void {
  if (typeof document === "undefined") return;
  const canonical = canonicalLanguageTag(language) || "en";
  document.documentElement.lang = canonical;
  document.documentElement.dir = documentDirectionForLanguage(canonical);
}

// Keep <html lang> and direction in sync with the active language (initial
// resolve + any manual switch) for CSS :lang(), layout and accessibility.
if (typeof document !== "undefined") {
  i18next.on("languageChanged", (lng) => {
    try {
      syncDocumentLanguage(lng);
    } catch {
      /* document may be unavailable in exotic contexts */
    }
  });
}

// ── Language preference API (for the in-app language selector) ─────────────
// "system" = follow the browser (no stored override); otherwise a language code.
export function currentLanguagePreference(): string {
  return storedLanguage() ?? "system";
}

export function setLanguagePreference(pref: string): void {
  const supportedLower = new Map(
    SUPPORTED_LANGUAGES.map((language) => [language.toLowerCase(), language]),
  );
  const resolved = pref === "system"
    ? "system"
    : supportedLanguageForCandidate(pref, supportedLower);
  if (!resolved) return;

  let persisted = false;
  try {
    if (resolved === "system") localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else localStorage.setItem(LANGUAGE_STORAGE_KEY, resolved);
    persisted = true;
  } catch {
    /* storage unavailable */
  }
  // Reload so EVERY surface renders in the new language: many option/label
  // arrays bake their strings in at module-evaluation time and would not
  // re-localize on a live changeLanguage. The selected preference is re-read
  // on boot. If we couldn't persist, fall back to a live switch.
  if (persisted && typeof window !== "undefined") window.location.reload();
  else void i18next.changeLanguage(resolved === "system" ? browserLanguage() : resolved);
}

export { i18next };
