#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'web', 'dist');
const indexPath = join(distDir, 'index.html');

const limits = {
  initialRaw: numberEnv('NOTIONLIKE_BUDGET_INITIAL_JS_RAW', 700_000),
  initialGzip: numberEnv('NOTIONLIKE_BUDGET_INITIAL_JS_GZIP', 220_000),
  initialTotalGzip: numberEnv('NOTIONLIKE_BUDGET_INITIAL_TOTAL_GZIP', 350_000),
  lazyRaw: numberEnv('NOTIONLIKE_BUDGET_LAZY_JS_RAW', 750_000),
  lazyGzip: numberEnv('NOTIONLIKE_BUDGET_LAZY_JS_GZIP', 260_000),
};

if (!existsSync(indexPath)) {
  throw new Error(`Web build is missing: ${indexPath}`);
}

const html = readFileSync(indexPath, 'utf8');
const initialRefs = new Set(
  [...html.matchAll(/\b(?:src|href)=["']([^"']+\.js)(?:[?#][^"']*)?["']/g)]
    .map((match) => match[1])
    .filter((path) => path.startsWith('/assets/') || path.startsWith('assets/')),
);
if (!initialRefs.size) throw new Error('No initial JavaScript bundle references were found in web/dist/index.html.');

const jsFiles = readdirSync(join(distDir, 'assets'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => join(distDir, 'assets', name));
const initialNames = new Set(Array.from(initialRefs, (ref) => basename(ref)));
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
  `PASS web bundle budget: ${initialNames.size} initial and ${jsFiles.length - initialNames.size} lazy chunks; ` +
    `${initialTotalGzip} initial gzip bytes.`,
);

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (!process.env[name]) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return Math.floor(value);
}
