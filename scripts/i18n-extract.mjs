#!/usr/bin/env node
// Consolidates all en/*.json into a single flat key->value JSON for translation,
// then expands a translated flat JSON back into per-namespace files.
//
// Usage:
//   node scripts/i18n-extract.mjs extract   → writes /tmp/i18n-en-flat.json
//   node scripts/i18n-extract.mjs expand <lang> <flat.json>  → writes <lang>/*.json
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, "..", "web", "src", "locales");

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function unflatten(flat) {
  const result = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let cur = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  return result;
}

function loadNamespace(ns) {
  const p = join(localesDir, "en", `${ns}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function namespaces() {
  return readdirSync(join(localesDir, "en"))
    .filter((f) => f.endsWith(".json") && f !== "_meta.json")
    .map((f) => f.slice(0, -5));
}

const mode = process.argv[2];
if (mode === "extract") {
  const flat = {};
  for (const ns of namespaces()) {
    const nsFlat = flatten(loadNamespace(ns), "", {});
    for (const [k, v] of Object.entries(nsFlat)) {
      flat[`${ns}:${k}`] = v;
    }
  }
  const out = process.argv[3] || "/tmp/i18n-en-flat.json";
  writeFileSync(out, JSON.stringify(flat, null, 2) + "\n");
  console.log(`Extracted ${Object.keys(flat).length} keys to ${out}`);
} else if (mode === "expand") {
  const lang = process.argv[3];
  const flatPath = process.argv[4];
  if (!lang || !flatPath) {
    console.error("Usage: expand <lang> <flat.json>");
    process.exit(1);
  }
  const flat = JSON.parse(readFileSync(flatPath, "utf8"));
  const byNs = {};
  for (const [id, value] of Object.entries(flat)) {
    const [ns, ...rest] = id.split(":");
    if (!byNs[ns]) byNs[ns] = {};
    byNs[ns][rest.join(":")] = value;
  }
  const langDir = join(localesDir, lang);
  if (!existsSync(langDir)) mkdirSync(langDir, { recursive: true });
  let count = 0;
  for (const ns of namespaces()) {
    const nsFlat = byNs[ns] || {};
    const obj = unflatten(nsFlat);
    writeFileSync(join(langDir, `${ns}.json`), JSON.stringify(obj, null, 2) + "\n");
    count += Object.keys(nsFlat).length;
  }
  console.log(`Expanded ${count} keys into ${lang}/*.json`);
} else {
  console.error("Usage: extract | expand <lang> <flat.json>");
  process.exit(1);
}