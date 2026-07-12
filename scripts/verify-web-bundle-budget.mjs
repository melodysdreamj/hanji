#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'web', 'dist');
const indexPath = join(distDir, 'index.html');
const precachePath = join(distDir, 'sw-precache.json');
const viteManifestPath = join(distDir, '.vite', 'manifest.json');

const limits = {
  initialRaw: numberEnv('HANJI_BUDGET_INITIAL_JS_RAW', 700_000),
  initialGzip: numberEnv('HANJI_BUDGET_INITIAL_JS_GZIP', 220_000),
  // Includes both language catalogs deliberately precached for a guaranteed
  // first-installed offline boot. Measured release baseline after the complete
  // en/ko migration is 364,286 bytes; keep less than 2% headroom.
  initialTotalGzip: numberEnv('HANJI_BUDGET_INITIAL_TOTAL_GZIP', 370_000),
  lazyRaw: numberEnv('HANJI_BUDGET_LAZY_JS_RAW', 750_000),
  lazyGzip: numberEnv('HANJI_BUDGET_LAZY_JS_GZIP', 260_000),
  bootJsRequests: numberEnv('HANJI_BUDGET_BOOT_JS_REQUESTS', 16),
  offlinePrecacheEntries: numberEnv('HANJI_BUDGET_OFFLINE_PRECACHE_ENTRIES', 256),
  offlinePrecacheRaw: numberEnv('HANJI_BUDGET_OFFLINE_PRECACHE_RAW', 12_000_000),
};

if (!existsSync(indexPath)) {
  throw new Error(`Web build is missing: ${indexPath}`);
}

const html = readFileSync(indexPath, 'utf8');
const viteManifest = JSON.parse(readFileSync(viteManifestPath, 'utf8'));
const initialRefs = new Set(
  [...html.matchAll(/\b(?:src|href)=["']([^"']+\.js)(?:[?#][^"']*)?["']/g)]
    .map((match) => match[1])
    .filter((path) => path.startsWith('/assets/') || path.startsWith('assets/')),
);
if (!existsSync(precachePath)) {
  throw new Error(`Service-worker precache manifest is missing: ${precachePath}`);
}
const precache = JSON.parse(readFileSync(precachePath, 'utf8'));
const bootAssets = Array.isArray(precache.bootAssets) ? precache.bootAssets : precache.assets ?? [];
for (const asset of bootAssets) {
  if (typeof asset === 'string' && /^\/assets\/[^/]+\.js$/.test(asset)) initialRefs.add(asset);
}
const offlineAssets = Array.isArray(precache.assets) ? precache.assets : [];
const offlineAssetSet = new Set(offlineAssets);
const bootAssetSet = new Set(bootAssets);
const requiredOfflineLanguages = new Set(['en', 'ko']);
for (const [key, entry] of Object.entries(viteManifest)) {
  const match = /^src\/locales\/([^/]+)\.ts$/.exec(key);
  if (!match || typeof entry?.file !== 'string') continue;
  const language = match[1];
  const asset = `/${entry.file}`;
  if (requiredOfflineLanguages.has(language)) {
    if (!bootAssetSet.has(asset)) {
      throw new Error(`Required offline language '${language}' is missing from bootAssets.`);
    }
  } else if (offlineAssetSet.has(asset)) {
    throw new Error(
      `Optional language '${language}' was pulled into the install precache instead of remaining lazy.`,
    );
  }
}
if (offlineAssets.length > limits.offlinePrecacheEntries) {
  throw new Error(
    `Offline precache has ${offlineAssets.length} entries; budget is ${limits.offlinePrecacheEntries}.`,
  );
}
let offlinePrecacheRaw = 0;
for (const asset of offlineAssets) {
  if (asset === '/') {
    offlinePrecacheRaw += statSync(indexPath).size;
    continue;
  }
  if (typeof asset !== 'string' || !asset.startsWith('/')) {
    throw new Error(`Offline precache contains an invalid path: ${String(asset)}`);
  }
  const assetPath = join(distDir, asset.slice(1));
  if (!existsSync(assetPath)) throw new Error(`Offline precache asset is missing: ${asset}`);
  offlinePrecacheRaw += statSync(assetPath).size;
}
if (offlinePrecacheRaw > limits.offlinePrecacheRaw) {
  throw new Error(
    `Offline precache totals ${offlinePrecacheRaw} raw bytes; budget is ${limits.offlinePrecacheRaw}.`,
  );
}
if (!initialRefs.size) throw new Error('No initial JavaScript bundle references were found in web/dist/index.html.');

const jsFiles = readdirSync(join(distDir, 'assets'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => join(distDir, 'assets', name));
const initialNames = new Set(Array.from(initialRefs, (ref) => basename(ref)));
if (initialNames.size > limits.bootJsRequests) {
  throw new Error(
    `Boot graph requires ${initialNames.size} JavaScript requests; budget is ${limits.bootJsRequests}.`,
  );
}
const yjsChunks = jsFiles.filter((path) => /^yjs-[^.]+\.js$/.test(basename(path)));
if (yjsChunks.length !== 1) {
  throw new Error(
    `Expected exactly one Yjs bundle identity, found ${yjsChunks.length}: ` +
      yjsChunks.map((path) => basename(path)).join(', '),
  );
}
if (jsFiles.some((path) => basename(path).toLowerCase().includes('_meta'))) {
  throw new Error('Translation _meta bookkeeping must not be emitted into the public bundle.');
}
let initialTotalGzip = 0;

for (const path of jsFiles) {
  const bytes = readFileSync(path);
  const raw = statSync(path).size;
  const gzip = gzipSync(bytes, { level: 9 }).byteLength;
  const initial = initialNames.has(basename(path));
  const rawLimit = initial ? limits.initialRaw : limits.lazyRaw;
  const gzipLimit = initial ? limits.initialGzip : limits.lazyGzip;
  if (initial) initialTotalGzip += gzip;
  if (raw > rawLimit || gzip > gzipLimit) {
    throw new Error(
      `${initial ? 'Initial' : 'Lazy'} chunk ${basename(path)} exceeds its budget: ` +
        `${raw} raw/${gzip} gzip bytes (limits ${rawLimit}/${gzipLimit}).`,
    );
  }
}

if (initialTotalGzip > limits.initialTotalGzip) {
  throw new Error(
    `Initial JavaScript totals ${initialTotalGzip} gzip bytes; budget is ${limits.initialTotalGzip}.`,
  );
}

console.log(
  `PASS web bundle budget: ${initialNames.size} boot and ${jsFiles.length - initialNames.size} lazy chunks; ` +
    `${initialTotalGzip} initial gzip bytes; ${offlineAssets.length} offline entries / ` +
    `${offlinePrecacheRaw} raw bytes.`,
);

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!process.env[name]) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return Math.floor(value);
}
