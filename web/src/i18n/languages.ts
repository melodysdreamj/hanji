// Display metadata for languages that are ready to select in the product.
// Translation targets that still fall back almost entirely to English keep
// their catalogs under src/locales/, but are intentionally not exposed here.
// `value` matches the folder/wrapper name and `label` is the endonym shown to
// the user. Order follows docs/i18n-languages.md priority waves.

export interface LanguageOption {
  value: string;
  label: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "zh-Hans", label: "简体中文" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "pt-BR", label: "Português (Brasil)" },
];
