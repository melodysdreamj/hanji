#!/usr/bin/env node
// Emits dist/sw-precache.json after the Vite build with two explicit graphs:
// bootAssets for fast service-worker installation, and assets for the complete
// product graph warmed after activation. The worker publishes a new offline
// shell only after the latter has been staged atomically.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const viteManifest = JSON.parse(readFileSync(resolve(dist, '.vite/manifest.json'), 'utf8'));
const bootAssets = new Set(
  [
    ...[...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]),
    // Synchronous root scripts (for example the CSP-safe pre-paint theme
    // initializer) are part of the app shell just as much as hashed modules.
    // Without precaching them, a cached navigation fails its first offline
    // reload even though the module graph itself is present.
    ...[...html.matchAll(/<script[^>]+src="(\/(?!\/)[^"]+)"/g)].map((match) => match[1]),
  ]
);

function includeManifestEntry(
  key,
  target,
  includeDynamic,
  seen = new Set(),
  excludedEntries = new Set(),
) {
  if (!key || seen.has(key) || excludedEntries.has(key)) return;
  seen.add(key);
  const entry = viteManifest[key];
  if (!entry) return;
  if (entry.file) target.add('/' + entry.file);
  for (const css of entry.css ?? []) target.add('/' + css);
  for (const asset of entry.assets ?? []) target.add('/' + asset);
  for (const imported of entry.imports ?? []) {
    includeManifestEntry(imported, target, includeDynamic, seen, excludedEntries);
  }
  if (includeDynamic) {
    for (const imported of entry.dynamicImports ?? []) {
      includeManifestEntry(imported, target, true, seen, excludedEntries);
    }
  }
}

const languageEntries = Object.keys(viteManifest).filter((key) =>
  /^src\/locales\/[^/]+\.ts$/.test(key)
);
if (languageEntries.length === 0) {
  throw new Error('No language catalog chunks were emitted; refusing an incomplete offline precache.');
}
const entryKey = Object.keys(viteManifest).find((key) => viteManifest[key]?.isEntry);
if (!entryKey) throw new Error('No Vite application entry was emitted.');
includeManifestEntry(entryKey, bootAssets, false);
// Only precache the fallback (en) and primary product language (ko) as boot
// assets. Other language chunks are lazy-loaded and runtime-cached on demand;
// if one is not cached during an offline boot, i18next falls back to the
// already-precached English catalog.
const PRECACHE_LANGUAGES = new Set(['en', 'ko']);
const bootLanguageEntries = languageEntries.filter((key) => {
  const code = key.replace(/^src\/locales\/([^/]+)\.ts$/, '$1');
  return PRECACHE_LANGUAGES.has(code);
});
for (const key of bootLanguageEntries) includeManifestEntry(key, bootAssets, false);

// A worker starts controlling only after the first page load. Browser HTTP
// cache is not an offline contract, so precache every reachable PRODUCT lazy
// module (route chunks, Editor/DatabaseView, and nested feature chunks) instead
// of assuming the first visit's uncontrolled requests remain available. Do not
// let the entry module's import.meta.glob pull every optional language chunk
// into that graph; those remain on-demand runtime-cache entries.
const assets = new Set(bootAssets);
const deferredLanguageEntries = new Set(
  languageEntries.filter((key) => !bootLanguageEntries.includes(key)),
);
includeManifestEntry(entryKey, assets, true, new Set(), deferredLanguageEntries);

const sortedAssets = ['/', ...Array.from(assets).sort()];
const versionHash = createHash('sha256');
for (const url of sortedAssets) {
  const file = url === '/' ? resolve(dist, 'index.html') : resolve(dist, url.slice(1));
  versionHash.update(url);
  versionHash.update('\0');
  versionHash.update(readFileSync(file));
  versionHash.update('\0');
}

const manifest = {
  version: versionHash.digest('hex').slice(0, 24),
  assets: sortedAssets,
  bootAssets: ['/', ...Array.from(bootAssets).sort()],
};
writeFileSync(
  resolve(dist, 'sw-precache.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
const rawBytes = (urls) => urls.reduce((total, url) => {
  const file = url === '/' ? resolve(dist, 'index.html') : resolve(dist, url.slice(1));
  return total + readFileSync(file).byteLength;
}, 0);
const bootBytes = rawBytes(manifest.bootAssets);
const totalBytes = rawBytes(manifest.assets);
console.log(
  'sw-precache.json: install ' + manifest.bootAssets.length + ' entries / ' + bootBytes +
    ' raw bytes; background ' + (manifest.assets.length - manifest.bootAssets.length) +
    ' entries / ' + (totalBytes - bootBytes) + ' raw bytes; full ' + manifest.assets.length +
    ' entries / ' + totalBytes + ' raw bytes (' + bootLanguageEntries.length + ' boot language chunks)'
);
