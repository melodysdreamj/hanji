// react-i18next runtime setup.
//
// English (src/locales/en) is the SOURCE OF TRUTH; every other language is a
// translation catalog tracked against it (staleness detected by
// scripts/i18n-status.mjs). Namespace files are auto-discovered by each
// src/locales/<lang>.ts wrapper; the wrappers themselves are auto-discovered by
// the Vite glob below. Adding a namespace needs no runtime change. Translation
// target wrappers may exist before a language is released in the selector.
//
// Locale selection: an authenticated account's server preference is mirrored
// into an account-scoped local cache for first paint. Public shares, signed-out
// visitors and anonymous sessions ignore that cache and follow the browser.
// Browser tags are normalized to a released catalog before i18next starts so
// script/region variants remain intact.
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

// Prefix for account-scoped language caches. Never read the old unscoped key as
// a preference: doing so would leak one account's UI language into another
// account or into a public share opened in the same browser.
export const LANGUAGE_STORAGE_KEY = "hanji:language";

export function languageStorageKey(userId: string): string {
  return `${LANGUAGE_STORAGE_KEY}:${encodeURIComponent(userId.trim())}`;
}

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

export function shouldUseAccountLanguagePreference(pathname: string): boolean {
  return pathname !== "/share" && !pathname.startsWith("/share/");
}

function normalizeLanguagePreference(pref: string): string | undefined {
  if (pref === "system") return "system";
  const supportedLower = new Map(
    SUPPORTED_LANGUAGES.map((language) => [language.toLowerCase(), language]),
  );
  return supportedLanguageForCandidate(pref, supportedLower);
}

function storedLanguagePreference(userId = ""): string | undefined {
  if (!userId) return undefined;
  try {
    const stored = localStorage.getItem(languageStorageKey(userId));
    if (!stored) return undefined;
    return normalizeLanguagePreference(stored);
  } catch {
    return undefined;
  }
}

export function browserLanguage(): string {
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

export async function initI18n(userIdHint = ""): Promise<unknown> {
  const useAccountPreference = typeof window !== "undefined"
    ? shouldUseAccountLanguagePreference(window.location.pathname)
    : false;
  const preference = useAccountPreference
    ? storedLanguagePreference(userIdHint)
    : undefined;
  const language = preference && preference !== "system" ? preference : browserLanguage();
  // The previous boot always waited for English before requesting the active
  // language. On a Korean (or any non-English) browser that serialized two
  // fairly large lazy chunks on the critical path. Fetch both catalogs in
  // parallel and seed i18next with them so its backend does not request either
  // one a second time during initialization.
  const [sourceCatalogs, activeCatalogs] = await Promise.all([
    loadLanguageCatalogs("en"),
    loadLanguageCatalogs(language),
  ]);
  const namespaces = Object.keys(sourceCatalogs);
  return i18next
    .use(resourceBackend)
    .use(initReactI18next)
    .init({
      lng: language,
      fallbackLng: "en",
      supportedLngs: SUPPORTED_LANGUAGES,
      // Detection is normalized before init so full script/region codes use
      // the intended released catalog instead of being reduced to a base code.
      load: "currentOnly",
      nonExplicitSupportedLngs: false,
      ns: namespaces.length > 0 ? namespaces : [DEFAULT_NS],
      defaultNS: DEFAULT_NS,
      // English + the active locale are bundled into the initial resource
      // object above; every other released locale remains lazy-loadable when
      // tests or the live language preference switch calls changeLanguage.
      partialBundledLanguages: true,
      resources: {
        en: sourceCatalogs,
        ...(language === "en" ? {} : { [language]: activeCatalogs }),
      },
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
// "system" = follow the browser; otherwise a released language code. System is
// stored explicitly after a user chooses it so it remains distinguishable from
// an account that has never completed language onboarding.
export function currentLanguagePreference(userId = ""): string {
  return storedLanguagePreference(userId) ?? "system";
}

export function hasCachedLanguagePreference(userId = ""): boolean {
  return storedLanguagePreference(userId) !== undefined;
}

export function resolvedLanguageForPreference(pref: string): string {
  const resolved = normalizeLanguagePreference(pref);
  return resolved && resolved !== "system" ? resolved : browserLanguage();
}

export function cacheLanguagePreference(userId: string, pref: string): boolean {
  const resolved = normalizeLanguagePreference(pref);
  if (!userId || !resolved) return false;
  try {
    localStorage.setItem(languageStorageKey(userId), resolved);
    return true;
  } catch {
    return false;
  }
}

export function setLanguagePreference(pref: string, userId = ""): void {
  const resolved = normalizeLanguagePreference(pref);
  if (!resolved) return;

  const persisted = cacheLanguagePreference(userId, resolved);
  const nextLanguage = resolvedLanguageForPreference(resolved);
  // Reload so EVERY surface renders in the new language: many option/label
  // arrays bake their strings in at module-evaluation time and would not
  // re-localize on a live changeLanguage. The selected preference is re-read
  // on boot. A no-op selection needs no reload; if storage is unavailable,
  // fall back to a live switch.
  if (persisted && nextLanguage !== i18next.resolvedLanguage && typeof window !== "undefined") {
    window.location.reload();
  } else if (!persisted) {
    void i18next.changeLanguage(nextLanguage);
  }
}

export { i18next };
