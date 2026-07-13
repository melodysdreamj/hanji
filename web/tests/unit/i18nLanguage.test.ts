// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  documentDirectionForLanguage,
  i18next,
  resolveSupportedLanguage,
  SUPPORTED_LANGUAGES,
  syncDocumentLanguage,
} from "@/i18n";
import { LANGUAGE_OPTIONS } from "@/i18n/languages";
import { activeDateLocale, activeNumberLocale } from "@/lib/i18n";

afterEach(async () => {
  await i18next.changeLanguage("en");
});

describe("resolveSupportedLanguage", () => {
  it("can select any catalog after that language is actually released", () => {
    expect(resolveSupportedLanguage(["fr-CA", "ko-KR"], ["en", "fr", "ko"])).toBe("fr");
    expect(resolveSupportedLanguage(["de-DE", "ko-KR"], ["en", "fr", "ko"])).toBe("ko");
  });

  it("normalizes Korean browser regions to the released Korean catalog", () => {
    expect(resolveSupportedLanguage(["ko-KR"])).toBe("ko");
    expect(resolveSupportedLanguage(["ko_KR"])).toBe("ko");
  });

  it("maps Simplified Chinese regions without showing Simplified to Traditional users", () => {
    expect(resolveSupportedLanguage(["zh-Hans"])).toBe("zh-Hans");
    expect(resolveSupportedLanguage(["zh-CN"])).toBe("zh-Hans");
    expect(resolveSupportedLanguage(["zh-SG"])).toBe("zh-Hans");
    expect(resolveSupportedLanguage(["zh-TW"])).toBe("en");
    expect(resolveSupportedLanguage(["zh-Hant"])).toBe("en");
    expect(resolveSupportedLanguage(["zh-HK", "ja-JP"])).toBe("ja");
  });

  it("preserves the released Brazilian Portuguese region", () => {
    expect(resolveSupportedLanguage(["pt-BR"])).toBe("pt-BR");
    expect(resolveSupportedLanguage(["pt_br"])).toBe("pt-BR");
    expect(resolveSupportedLanguage(["pt"])).toBe("pt-BR");
    expect(resolveSupportedLanguage(["pt-PT"])).toBe("en");
  });

  it("keeps only released translations reachable from the language selector", () => {
    const runtimeLanguages = [...SUPPORTED_LANGUAGES].sort();
    const selectorLanguages = LANGUAGE_OPTIONS.map((option) => option.value).sort();
    expect(runtimeLanguages).toEqual(selectorLanguages);
    expect(runtimeLanguages).toEqual([
      "de",
      "en",
      "es",
      "fr",
      "ja",
      "ko",
      "pt-BR",
      "zh-Hans",
    ]);
  });

  it("falls back to the English source catalog when no browser language is supported", () => {
    expect(resolveSupportedLanguage(["de-DE"], ["en", "ko"])).toBe("en");
  });
});

describe("document locale metadata", () => {
  it("sets canonical lang and direction for released LTR languages", () => {
    syncDocumentLanguage("pt_br");
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(document.documentElement.dir).toBe("ltr");

    syncDocumentLanguage("zh-hans");
    expect(document.documentElement.lang).toBe("zh-Hans");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("keeps the RTL direction policy ready while RTL languages remain hidden", () => {
    expect(documentDirectionForLanguage("ar-EG")).toBe("rtl");
    expect(documentDirectionForLanguage("he-IL")).toBe("rtl");
    expect(documentDirectionForLanguage("fa-IR")).toBe("rtl");
    expect(documentDirectionForLanguage("ur-PK")).toBe("rtl");
    expect(documentDirectionForLanguage("ko-KR")).toBe("ltr");

    syncDocumentLanguage("ar-EG");
    expect(document.documentElement.lang).toBe("ar-EG");
    expect(document.documentElement.dir).toBe("rtl");
  });
});

describe("script and region catalog loading", () => {
  it("loads the Simplified Chinese and Brazilian Portuguese catalogs", async () => {
    await i18next.changeLanguage("zh-Hans");
    expect(i18next.t("workspaceSettingsDialog:languageField")).toBe("语言");

    await i18next.changeLanguage("pt-BR");
    expect(i18next.t("workspaceSettingsDialog:languageField")).toBe("Idioma");
  });
});

describe("active Intl locale", () => {
  it("follows the application language for dates and numbers", async () => {
    await i18next.changeLanguage("en");
    expect(activeDateLocale()).toBe("en-US");
    expect(activeNumberLocale()).toBe("en-US");

    await i18next.changeLanguage("ko");
    expect(activeDateLocale()).toBe("ko-KR");
    expect(activeNumberLocale()).toBe("ko-KR");
  });
});
