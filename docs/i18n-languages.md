# Language roadmap (i18n)

Target languages for Hanji's UI localization. English (`en`) is the **source of
truth**; every other language is a translation catalog under
`web/src/locales/<code>/`.

## Selectable now

All **58** catalogs in the full list below are selectable and browser-detectable:
English and Korean plus the 56 translated target languages. Every catalog is
current against the 3,534-key English source as of 2026-07-14. The 56
machine-translated baselines remain subject to later terminology and native
speaker QA, but they are no longer hidden scaffolds.

Locale priority is account-aware:

1. A signed-in, non-anonymous account uses its server-stored preference.
2. If that account has never chosen a language, Hanji asks once per sign-in
   until the choice is successfully saved; the detected browser language is
   selected and listed first as the recommendation.
3. Public shares, signed-out visitors, local anonymous sessions, and any state
   without a usable account preference follow the browser language.
4. English is the ultimate fallback.

The local first-paint cache is keyed by user ID, so one account's language is
never reused by another account or by a public share. Browser normalization
preserves script/region variants: `ko-KR` uses `ko`, `zh-CN`/`zh-SG` use
`zh-Hans`, `zh-TW`/`zh-HK`/`zh-MO` use `zh-Hant`, and Portuguese keeps the
`pt-BR` and `pt-PT` regional catalogs.

## How a language gets added

The infrastructure supports **any number** of languages — there is no cap.

1. Translate a folder `web/src/locales/<code>/`. Do not ship an English-copy
   scaffold: the guard rejects catalogs whose values are all still identical
   to the English source.
2. Add a small `web/src/locales/<code>.ts` wrapper mirroring `en.ts`; Vite
   auto-discovers these wrappers and keeps each complete language in one lazy
   chunk.
3. Run `npm --prefix web run i18n:status` to see every missing/stale key.
4. Translate the JSON namespaces (mirror the `en/` structure and keep
   `{{interpolation}}` placeholders).
5. Run `npm --prefix web run i18n:sync <code>` to stamp it caught-up.
6. Only after the catalog is ready, add the code and endonym to
   `web/src/i18n/languages.ts`. The release guard requires each selectable
   language to have a catalog and runtime wrapper and rejects English-copy
   scaffolds.

Do **not** leave Korean that is data-matching logic translated as a label
(search keywords/aliases, status-name comparisons, CJK-width regex) — those stay
literal; see the `i18n react-i18next catalog` notes.

## Script/effort groups

- **CJK (already handled):** the i18n system already covers CJK plural rules
  (`_other` only), character-width, and per-locale search keywords.
- **RTL (released; QA remains):** the document `dir` policy is implemented and
  tested for Arabic/Hebrew/Persian/Urdu. Continue full workflow-level RTL visual
  QA as a dedicated follow-up rather than treating translation completeness as
  proof of pixel-perfect layout.
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
| Selectable now | 58 |
| Hidden translation targets | 0 |
| **Catalog/runtime total** | **58** |

The technical ceiling is higher — i18next/CLDR supports 100+ locales, and
regional variants (`en-GB`, `fr-CA`, `es-419`, …) could extend it further. The
56 above are the ones with a meaningful user base; speaker counts drop sharply
below this.
