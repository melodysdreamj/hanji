#!/usr/bin/env node
// Emits dist/sw-precache.json after `vite build`: the app shell plus the
// entry assets referenced by dist/index.html. The service worker precaches
// these at install, making even the FIRST visit offline-reloadable (lazy
// chunks stay runtime-cached — they join the cache when first used).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const assets = [
  ...new Set(
    [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1])
  ),
];
const manifest = { assets: ['/', ...assets] };
writeFileSync(resolve(dist, 'sw-precache.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`sw-precache.json: ${manifest.assets.length} entries`);
