import { afterEach, describe, expect, it } from "vitest";

import { i18next, resolveSupportedLanguage, SUPPORTED_LANGUAGES } from "@/i18n";
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

  it("keeps every release catalog reachable from the language selector", () => {
    const runtimeLanguages = [...SUPPORTED_LANGUAGES].sort();
    const selectorLanguages = LANGUAGE_OPTIONS.map((option) => option.value).sort();
    expect(runtimeLanguages).toEqual(selectorLanguages);
    expect(runtimeLanguages).toEqual(expect.arrayContaining([
      "de",
      "en",
      "es",
      "fr",
      "ja",
      "ko",
      "pt-BR",
      "zh-Hans",
    ]));
  });

  it("falls back to the English source catalog when no browser language is supported", () => {
    expect(resolveSupportedLanguage(["de-DE"], ["en", "ko"])).toBe("en");
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
