# Language roadmap (i18n)

Target languages for Hanji's UI localization. English (`en`) is the **source of
truth**; every other language is a translation catalog under
`web/src/locales/<code>/`.

## Status

- ✅ **Korean** (`ko`) — original market, fully translated
- ✅ **English** (`en`) — source of truth / international default
- ✅ **Japanese** (`ja`) — Wave 1, translated
- ✅ **Chinese Simplified** (`zh-Hans`) — Wave 1, translated
- ✅ **Spanish** (`es`) — Wave 1, translated
- ✅ **French** (`fr`) — Wave 1, translated
- ✅ **German** (`de`) — Wave 1, translated
- ✅ **Portuguese (Brazil)** (`pt-BR`) — Wave 1, translated
- ⏳ **50 languages below** — infrastructure ready (folders, wrappers, selector
  options, English fallback catalogs) but **not yet translated**. Users can
  select them; the UI falls back to English until translation is done. The i18n
  guard skips the untranslated-copy check for these.

Locale is navigator-driven with an optional in-app override
(Settings → Preferences → Language); English is the ultimate fallback.

## How a language gets added

The infrastructure supports **any number** of languages — there is no cap.

1. Translate a folder `web/src/locales/<code>/`. Do not ship an English-copy
   scaffold: the guard rejects catalogs whose values are all still identical
   to the English source.
2. Add a small `web/src/locales/<code>.ts` wrapper mirroring `en.ts`; Vite
   auto-discovers these wrappers and keeps each complete language in one lazy
   chunk.
3. Add the code and endonym to `web/src/i18n/languages.ts`. The release guard
   requires catalog directory, runtime wrapper, and selector entry to agree, so
   a translated-but-unreachable language cannot pass CI.
4. Run `npm --prefix web run i18n:status` to see every missing/stale key.
5. Translate the JSON namespaces (mirror the `en/` structure and keep
   `{{interpolation}}` placeholders).
6. Run `npm --prefix web run i18n:sync <code>` to stamp it caught-up.

Do **not** leave Korean that is data-matching logic translated as a label
(search keywords/aliases, status-name comparisons, CJK-width regex) — those stay
literal; see the `i18n react-i18next catalog` notes.

## Script/effort groups

- **CJK (already handled):** the i18n system already covers CJK plural rules
  (`_other` only), character-width, and per-locale search keywords.
- **RTL (needs layout work):** Arabic/Hebrew/Persian/Urdu require right-to-left
  layout support, not just translation — schedule these as their own wave.
- **Latin / Cyrillic / Indic (translation-only):** only per-language plural
  rules differ; no code work.

## Priority waves (recommended order)

- **Wave 1 — core:** `ja`, `zh-Hans`, `es`, `fr`, `de`, `pt-BR`
- **Wave 2 — expansion:** `zh-Hant`, `it`, `ru`, `id`, `vi`
- **Wave 3 — RTL (with a right-to-left layout pass):** `ar`, `he`, `fa`, `ur`
- **Long tail:** everything else below, as demand appears.

Coverage: ~top 15 languages ≈ most of the paying SaaS market; ~top 40 ≈ nearly
all meaningful digital markets; the full list ≈ maximum accessibility.

## Full target list (56 beyond ko/en)

### East Asia — CJK (3)
| Code | Language | Native |
|---|---|---|
| `ja` | Japanese | 日本語 |
| `zh-Hans` | Chinese (Simplified) | 简体中文 |
| `zh-Hant` | Chinese (Traditional) | 繁體中文 |

### Western & Northern Europe — Latin (11)
| Code | Language | Native |
|---|---|---|
| `es` | Spanish | Español |
| `fr` | French | Français |
| `de` | German | Deutsch |
| `pt-BR` | Portuguese (Brazil) | Português (Brasil) |
| `pt-PT` | Portuguese (Europe) | Português (Portugal) |
| `it` | Italian | Italiano |
| `nl` | Dutch | Nederlands |
| `sv` | Swedish | Svenska |
| `da` | Danish | Dansk |
| `nb` | Norwegian | Norsk |
| `fi` | Finnish | Suomi |

### Central & Eastern Europe (12)
| Code | Language | Native |
|---|---|---|
| `pl` | Polish | Polski |
| `cs` | Czech | Čeština |
| `sk` | Slovak | Slovenčina |
| `hu` | Hungarian | Magyar |
| `ro` | Romanian | Română |
| `el` | Greek | Ελληνικά |
| `hr` | Croatian | Hrvatski |
| `sr` | Serbian | Српски |
| `sl` | Slovenian | Slovenščina |
| `bg` | Bulgarian | Български |
| `uk` | Ukrainian | Українська |
| `ru` | Russian | Русский |

### Middle East — RTL (4) ⚠️ requires right-to-left layout
| Code | Language | Native |
|---|---|---|
| `ar` | Arabic | العربية |
| `he` | Hebrew | עברית |
| `fa` | Persian | فارسی |
| `ur` | Urdu | اردو |

### South Asia — Indic (11)
| Code | Language | Native |
|---|---|---|
| `hi` | Hindi | हिन्दी |
| `bn` | Bengali | বাংলা |
| `ta` | Tamil | தமிழ் |
| `te` | Telugu | తెలుగు |
| `mr` | Marathi | मराठी |
| `gu` | Gujarati | ગુજરાતી |
| `kn` | Kannada | ಕನ್ನಡ |
| `pa` | Punjabi | ਪੰਜਾਬੀ |
| `ml` | Malayalam | മലയാളം |
| `ne` | Nepali | नेपाली |
| `si` | Sinhala | සිංහල |

### Southeast Asia (7)
| Code | Language | Native |
|---|---|---|
| `vi` | Vietnamese | Tiếng Việt |
| `th` | Thai | ไทย |
| `id` | Indonesian | Bahasa Indonesia |
| `ms` | Malay | Bahasa Melayu |
| `fil` | Filipino | Filipino |
| `my` | Burmese | မြန်မာ |
| `km` | Khmer | ខ្មែរ |

### Turkic & Central Asia (4)
| Code | Language | Native |
|---|---|---|
| `tr` | Turkish | Türkçe |
| `az` | Azerbaijani | Azərbaycanca |
| `kk` | Kazakh | Қазақша |
| `uz` | Uzbek | Oʻzbekcha |

### Africa (4)
| Code | Language | Native |
|---|---|---|
| `sw` | Swahili | Kiswahili |
| `am` | Amharic | አማርኛ |
| `af` | Afrikaans | Afrikaans |
| `ha` | Hausa | Hausa |

## Totals

| | Count |
|---|---|
| Shipped (`ko`, `en`) | 2 |
| Target list above | 56 |
| **Total** | **~58** |

The technical ceiling is higher — i18next/CLDR supports 100+ locales, and
regional variants (`en-GB`, `fr-CA`, `es-419`, …) could extend it further. The
56 above are the ones with a meaningful user base; speaker counts drop sharply
below this.
