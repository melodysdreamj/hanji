#!/usr/bin/env node
// i18n status / staleness guard.
//
// English (web/src/locales/en) is the SOURCE OF TRUTH. Every other language is
// a translation tracked against the exact English value it was translated
// from, via a per-locale `_meta.json` that records a hash of that English
// source value at translation time.
//
// Modes:
//   (default)        Report MISSING / STALE / ORPHAN keys per target language.
//                    Coverage (MISSING/STALE/ORPHAN) only gates CI for the
//                    REQUIRED_RELEASED_LANGUAGES (en source + ko). Every other
//                    language is reported but non-gating on coverage, so new
//                    strings ship in en+ko and the rest catch up later (runtime
//                    falls back to English). Structural corruption
//                    (shape/interpolation/untranslated-copy) still gates every
//                    language. Exits 1 if any gating problem remains.
//   --sync <locale>  Stamp the current English hashes into <locale>/_meta.json
//                    for every key that locale currently translates, marking it
//                    "caught up" to English. Run after a translation pass.
//                    `--sync all` syncs every target language.
//   --json           Machine-readable report to stdout.
//
// Workflow: develop in English (edit en/*.json freely), then translate the same
// keys into ko and `--sync ko`. Other languages drift to STALE/MISSING but stay
// non-gating and keep working via English fallback until a later translation
// pass clears their flags with `--sync <locale>`.
//
// Node builtins only — no dependencies.
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, "..", "web", "src", "locales");
const languageOptionsPath = resolve(here, "..", "web", "src", "i18n", "languages.ts");
const SOURCE = "en";
const META = "_meta.json";
const REQUIRED_RELEASED_LANGUAGES = ["en", "ko"];
// Languages that have been genuinely translated (not just English copies).
// The UNTRANSLATED_COPY guard only fires for these; other languages are
// infrastructure-ready but pending translation per docs/i18n-languages.md.
const TRANSLATED_LANGUAGES = new Set(["ko", "ja", "zh-Hans", "es", "fr", "de", "pt-BR"]);
const INTENTIONAL_INTERPOLATION_VARIANTS = new Map([
  ["ko", new Set([
    // Korean builds a date from numeric year/month/day instead of the English
    // preformatted `date` token.
    "dateUtils:notionTimestamp",
    // Korean count units are suffixes attached directly to the number, so the
    // separate English candidate/item/request noun tokens are intentionally
    // absent while the numeric facts remain present.
    "importDialog:rootScanProgress",
    "importDialog:rootScanFound",
  ])],
]);

function hash(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

function namespacesOf(lang) {
  const dir = join(localesDir, lang);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== META)
    .map((f) => f.slice(0, -5));
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function loadFlat(lang, ns) {
  const p = join(localesDir, lang, `${ns}.json`);
  if (!existsSync(p)) return {};
  return flatten(JSON.parse(readFileSync(p, "utf8")), "", {});
}

// `${ns}:${dotted.key}` -> value (or -> {value, hash} for the source).
function loadSource() {
  const map = {};
  for (const ns of namespacesOf(SOURCE)) {
    for (const [key, value] of Object.entries(loadFlat(SOURCE, ns))) {
      map[`${ns}:${key}`] = { value, hash: hash(value) };
    }
  }
  return map;
}

function loadLocale(lang) {
  const map = {};
  for (const ns of namespacesOf(lang)) {
    for (const [key, value] of Object.entries(loadFlat(lang, ns))) {
      map[`${ns}:${key}`] = value;
    }
  }
  return map;
}

function loadMeta(lang) {
  const p = join(localesDir, lang, META);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

function interpolationNames(value) {
  const names = new Set();
  const visit = (entry) => {
    if (typeof entry === "string") {
      for (const match of entry.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)) names.add(match[1]);
    } else if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
    }
  };
  visit(value);
  return [...names].sort();
}

function valueShape(value) {
  return Array.isArray(value) ? `array:${value.length}` : typeof value;
}

function targetLanguages() {
  return readdirSync(localesDir).filter(
    (f) => f !== SOURCE && statSync(join(localesDir, f)).isDirectory(),
  );
}

function catalogTopologyProblems() {
  const entries = readdirSync(localesDir);
  const directories = new Set(
    entries.filter((name) => statSync(join(localesDir, name)).isDirectory()),
  );
  const wrappers = new Set(
    entries
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.slice(0, -3)),
  );
  const optionsSource = readFileSync(languageOptionsPath, "utf8");
  const options = new Set(
    [...optionsSource.matchAll(/\bvalue\s*:\s*["']([^"']+)["']/g)]
      .map((match) => match[1]),
  );
  const problems = [];
  for (const language of REQUIRED_RELEASED_LANGUAGES) {
    if (!directories.has(language)) problems.push(`required catalog directory is missing: ${language}`);
    if (!wrappers.has(language)) problems.push(`required runtime wrapper is missing: ${language}.ts`);
    if (!options.has(language)) problems.push(`required language selector option is missing: ${language}`);
  }
  for (const language of directories) {
    if (!wrappers.has(language)) problems.push(`catalog directory has no runtime wrapper: ${language}.ts`);
    if (!options.has(language)) problems.push(`catalog directory is absent from the selector: ${language}`);
  }
  for (const language of wrappers) {
    if (!directories.has(language)) problems.push(`runtime wrapper has no catalog directory: ${language}.ts`);
    if (!options.has(language)) problems.push(`runtime language is absent from the selector: ${language}`);
  }
  for (const language of options) {
    if (!wrappers.has(language)) problems.push(`language selector option has no runtime wrapper: ${language}`);
  }
  return problems;
}

// i18next plural categories. A source plural variant (e.g. "…count_one") is
// satisfied when the target provides the "_other" form for that base: every
// CLDR language has "_other", and languages use different extra categories
// (Korean: other only; English: one + other). Without this the guard would
// demand an English "_one" that Korean must not carry.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
function pluralOther(id) {
  const m = PLURAL_SUFFIX.exec(id);
  return m ? `${id.slice(0, m.index)}_other` : null;
}

function analyze(lang, source) {
  const locale = loadLocale(lang);
  const meta = loadMeta(lang);
  const missing = [];
  const stale = [];
  const orphan = [];
  const shapeMismatch = [];
  const interpolationMismatch = [];
  let compared = 0;
  let sourceIdentical = 0;
  for (const id of Object.keys(source)) {
    // A key PRESENT with an empty string is a deliberate translation (e.g. a
    // Korean confirm body needs no prefix where English does) — only an ABSENT
    // key counts as untranslated. Absence is what a translator leaves behind.
    if (!(id in locale)) {
      const other = pluralOther(id);
      if (other && other in locale) continue;
      missing.push(id);
    } else if (meta[id] !== source[id].hash) {
      stale.push(id);
    }
    if (id in locale) {
      compared += 1;
      if (JSON.stringify(locale[id]) === JSON.stringify(source[id].value)) {
        sourceIdentical += 1;
      }
      const sourceShape = valueShape(source[id].value);
      const targetShape = valueShape(locale[id]);
      if (sourceShape !== targetShape) {
        shapeMismatch.push({ id, source: sourceShape, target: targetShape });
      }
      if (
        sourceShape === targetShape &&
        !INTENTIONAL_INTERPOLATION_VARIANTS.get(lang)?.has(id)
      ) {
        const sourceNames = interpolationNames(source[id].value);
        const targetNames = interpolationNames(locale[id]);
        if (JSON.stringify(sourceNames) !== JSON.stringify(targetNames)) {
          interpolationMismatch.push({ id, source: sourceNames, target: targetNames });
        }
      }
    }
  }
  for (const id of Object.keys(locale)) {
    if (id in source) continue;
    const other = pluralOther(id);
    if (other && other in source) continue;
    orphan.push(id);
  }
  const untranslatedCopy =
    compared > 0 &&
    missing.length === 0 &&
    sourceIdentical === compared &&
    TRANSLATED_LANGUAGES.has(lang);
  return {
    missing,
    stale,
    orphan,
    shapeMismatch,
    interpolationMismatch,
    untranslatedCopy,
    translated: Object.keys(source).length - missing.length,
  };
}

function report(asJson) {
  const source = loadSource();
  const total = Object.keys(source).length;
  const result = {};
  const topology = catalogTopologyProblems();
  let problems = topology.length;
  for (const lang of targetLanguages()) {
    const a = analyze(lang, source);
    result[lang] = a;
    // Only en+ko gate CI on coverage (MISSING/STALE/ORPHAN) so a new string can
    // ship in en+ko without touching every other locale; the rest catch up
    // later (runtime falls back to English). Structural corruption still gates
    // every language — a broken shape/interpolation is a bug, not a lag.
    const gatesCoverage = REQUIRED_RELEASED_LANGUAGES.includes(lang);
    problems +=
      (gatesCoverage ? a.missing.length + a.stale.length + a.orphan.length : 0) +
      a.shapeMismatch.length +
      a.interpolationMismatch.length +
      Number(a.untranslatedCopy);
  }
  if (asJson) {
    console.log(JSON.stringify({ source: SOURCE, total, topology, languages: result }, null, 2));
    process.exit(problems > 0 ? 1 : 0);
  }
  for (const problem of topology) console.log(`\n  TOPOLOGY  ${problem}`);
  for (const lang of Object.keys(result)) {
    const a = result[lang];
    const pct = total ? Math.round((a.translated / total) * 100) : 100;
    console.log(
      `\n[${lang}] ${a.translated}/${total} keys (${pct}%)  ` +
        `missing=${a.missing.length} stale=${a.stale.length} orphan=${a.orphan.length}`,
    );
    for (const id of a.missing) console.log(`  MISSING  ${id}  → "${source[id].value}"`);
    for (const id of a.stale) console.log(`  STALE    ${id}  (en changed → "${source[id].value}")`);
    for (const id of a.orphan) console.log(`  ORPHAN   ${id}  (not in en source)`);
    for (const entry of a.shapeMismatch) {
      console.log(`  SHAPE  ${entry.id}  source=${entry.source} target=${entry.target}`);
    }
    for (const entry of a.interpolationMismatch) {
      console.log(
        `  INTERPOLATION  ${entry.id}  source=[${entry.source.join(", ")}] ` +
          `target=[${entry.target.join(", ")}]`,
      );
    }
    if (a.untranslatedCopy) {
      console.log("  UNTRANSLATED_COPY  every catalog value is still identical to English");
    }
  }
  if (problems > 0) {
    console.log(
      `\n✗ i18n guard: ${problems} topology, missing, stale, orphan, shape, interpolation, or untranslated-copy ` +
        `problem${problems === 1 ? "" : "s"}. Translate, then: ` +
        `npm --prefix web run i18n:sync <locale>`,
    );
    process.exit(1);
  }
  console.log(`\n✓ i18n guard: ${total} source keys; every released target is translated and current.`);
}

function sync(which) {
  const source = loadSource();
  const langs = which === "all" || !which ? targetLanguages() : [which];
  for (const lang of langs) {
    if (!existsSync(join(localesDir, lang))) {
      console.error(`unknown locale: ${lang}`);
      process.exit(2);
    }
    const locale = loadLocale(lang);
    const meta = {};
    for (const [id, { hash: h }] of Object.entries(source)) {
      if (id in locale) meta[id] = h;
    }
    writeFileSync(join(localesDir, lang, META), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`synced ${lang}/${META} — ${Object.keys(meta).length} keys stamped to current en source.`);
  }
}

const args = process.argv.slice(2);
if (args[0] === "--sync") sync(args[1]);
else report(args.includes("--json"));
