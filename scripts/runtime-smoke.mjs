#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  fetchWithTimeout,
  normalizeBaseUrl,
  resolveUrl,
  setDefaultTimeoutMs,
} from './lib/harness.mjs';

const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 5_000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const htmlRoutes = [
  '/',
  '/settings',
  '/account',
  '/trash',
  '/p/runtime-smoke-page',
  '/database/runtime-smoke-database',
  '/workspace/runtime-smoke-workspace',
  '/share/runtime-smoke-share',
  '/share/runtime-smoke-share?page=runtime-smoke-child&p=runtime-smoke-row',
];

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL runtime smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error(`Start the local EdgeBase runtime first: npm --prefix backend run dev`);
  }
  process.exit(1);
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Runtime smoke target: ${baseUrl}`);

  await assertRuntimeHealth(baseUrl);
  await assertProductHealth(baseUrl);
  await assertRuntimeConfig(baseUrl);
  await assertLocalCookieAuthOrigins(baseUrl);
  await assertRawDatabaseDenied(baseUrl);

  let rootHtml = '';
  for (const route of htmlRoutes) {
    const html = await assertHtmlRoute(baseUrl, route);
    if (route === '/') rootHtml = html;
  }

  await assertReferencedAssets(baseUrl, rootHtml);
  if (options.checkLocalDist) {
    await assertServedBundleMatchesDist(rootHtml);
  } else {
    console.log('SKIP local web/dist freshness check; validating runtime-served assets only.');
  }
  console.log(
    '\nPASS EdgeBase runtime enforces raw-DB denial and serves secured SPA fallback routes and built assets.',
  );
}

function parseArgs(args) {
  const parsed = {
    checkLocalDist: true,
    url: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--skip-local-dist-check') {
      parsed.checkLocalDist = false;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/runtime-smoke.mjs [options]

Checks a running local EdgeBase Hanji runtime without browser screenshots.
When web/dist exists, also checks that the running runtime serves the latest
local built SPA asset references.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or http://127.0.0.1:8787.
  --skip-local-dist-check Skip comparing served frontend asset names with local web/dist.
                          Use this for hosted/public runtimes where local dist may differ.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}

async function assertRuntimeHealth(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
  });
  const body = await response.text();

  assert(response.ok, `/api/health returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  assert(
    !looksLikeHtml(body),
    '/api/health returned HTML; API requests must not fall through to the SPA entrypoint',
  );

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`/api/health did not return JSON: ${body.slice(0, 200)}`);
  }

  assert(json?.status === 'ok', '/api/health JSON must include status: "ok"');
  console.log('PASS /api/health returns EdgeBase runtime JSON.');
}

async function assertProductHealth(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/functions/health'), {
    headers: { Accept: 'application/json' },
  });
  const body = await response.text();

  assert(
    response.ok,
    `/api/functions/health returned HTTP ${response.status}: ${body.slice(0, 200)}`,
  );
  assert(
    !looksLikeHtml(body),
    '/api/functions/health returned HTML; product function requests must not fall through to the SPA entrypoint',
  );

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`/api/functions/health did not return JSON: ${body.slice(0, 200)}`);
  }

  assert(json?.ok === true, '/api/functions/health JSON must include ok: true');
  assert(json?.status === 'ready', '/api/functions/health JSON must include status: "ready"');
  assert(
    json?.checks?.database === 'ok',
    '/api/functions/health JSON must confirm database readiness',
  );
  assert(
    typeof json?.requestId === 'string' && json.requestId,
    '/api/functions/health JSON must include a request identifier',
  );
  assert(
    json?.service === 'hanji-edgebase',
    '/api/functions/health JSON must identify the hanji-edgebase service',
  );
  console.log('PASS /api/functions/health returns Hanji product JSON.');
}

async function assertRuntimeConfig(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/functions/runtime-config'), {
    headers: { Accept: 'application/json' },
  });
  const body = await response.text();

  assert(
    response.ok,
    `/api/functions/runtime-config returned HTTP ${response.status}: ${body.slice(0, 200)}`,
  );
  assert(
    !looksLikeHtml(body),
    '/api/functions/runtime-config returned HTML; product config requests must not fall through to the SPA entrypoint',
  );

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`/api/functions/runtime-config did not return JSON: ${body.slice(0, 200)}`);
  }

  assert(json?.ok === true, '/api/functions/runtime-config JSON must include ok: true');
  assert(
    typeof json?.allowAnonymousBootstrap === 'boolean',
    '/api/functions/runtime-config JSON must include boolean allowAnonymousBootstrap',
  );
  for (const key of ['sourceUrl', 'agplLicenseUrl', 'sponsorExceptionUrl']) {
    const configured = json?.legal?.[key];
    assert(
      typeof configured === 'string' && configured.startsWith('https://'),
      `/api/functions/runtime-config legal.${key} must be a public HTTPS URL`,
    );
  }
  console.log('PASS /api/functions/runtime-config returns product runtime config JSON.');
}

async function assertLocalCookieAuthOrigins(baseUrl) {
  const target = new URL(baseUrl);
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    console.log('SKIP loopback cookie-auth origin probes for a non-local runtime.');
    return;
  }

  const origins = new Set([target.origin]);
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    for (const alias of ['localhost', '127.0.0.1']) {
      const candidate = new URL(target.origin);
      candidate.hostname = alias;
      origins.add(candidate.origin);
    }
  }

  for (const origin of origins) {
    const response = await fetchWithTimeout(resolveUrl(origin, '/api/auth/signin'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: origin,
        'X-EdgeBase-Auth-Transport': 'cookie',
      },
      body: JSON.stringify({
        email: 'runtime-origin-probe@example.invalid',
        password: 'SyntheticOriginProbe!2026',
      }),
    });
    const body = await response.text();
    assert(
      response.status === 401,
      `${origin} cookie-auth origin probe must reach credential validation (HTTP 401); got ${response.status}: ${body.slice(0, 200)}`,
    );
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`${origin} cookie-auth origin probe did not return JSON: ${body.slice(0, 200)}`);
    }
    assert(
      json?.slug === 'invalid-credentials',
      `${origin} cookie-auth origin probe returned unexpected error slug ${String(json?.slug)}`,
    );
  }

  console.log(`PASS cookie-auth origin validation reaches credentials on ${Array.from(origins).join(' and ')}.`);
}

async function assertRawDatabaseDenied(baseUrl) {
  const routes = [
    '/api/db/app/tables/workspaces?limit=1',
    '/api/db/workspace/runtime-smoke-workspace/tables/pages?limit=1',
  ];

  for (const route of routes) {
    const response = await fetchWithTimeout(resolveUrl(baseUrl, route), {
      headers: { Accept: 'application/json' },
    });
    const body = await response.text();
    assert(
      response.status === 403,
      `${route} must deny unauthenticated raw database access with HTTP 403; got ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  console.log('PASS unauthenticated central and workspace raw database reads are denied.');
}

async function assertHtmlRoute(baseUrl, route) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, route), {
    headers: { Accept: 'text/html' },
  });
  const body = await response.text();

  assert(response.ok, `${route} returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  assert(
    /<div[^>]+id=["']root["']/.test(body),
    `${route} did not return the SPA entrypoint`,
  );
  assert(looksLikeHtml(body), `${route} did not return HTML`);
  assertFrontendSecurityHeaders(response, route);

  console.log(`PASS ${route} serves the SPA entrypoint.`);
  return body;
}

function assertFrontendSecurityHeaders(response, route) {
  const expected = {
    'content-security-policy': "default-src 'self'",
    'permissions-policy': 'camera=()',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };

  for (const [name, marker] of Object.entries(expected)) {
    const value = response.headers.get(name) ?? '';
    assert(value.includes(marker), `${route} is missing required ${name} response policy`);
  }
}

async function assertReferencedAssets(baseUrl, html) {
  const assetRefs = extractAssetRefs(html);
  assert(assetRefs.length > 0, 'SPA entrypoint does not reference built frontend assets');

  const extensions = new Set(assetRefs.map((assetRef) => extensionOf(assetRef)));
  assert(extensions.has('.js'), 'SPA entrypoint does not reference a JavaScript bundle');
  assert(extensions.has('.css'), 'SPA entrypoint does not reference a CSS bundle');

  for (const assetRef of assetRefs) {
    const response = await fetchWithTimeout(resolveUrl(baseUrl, assetRef), {
      headers: { Accept: '*/*' },
    });
    const bytes = await response.arrayBuffer();
    assert(response.ok, `${assetRef} returned HTTP ${response.status}`);
    assert(bytes.byteLength > 0, `${assetRef} is empty`);
  }

  console.log(`PASS ${assetRefs.length} referenced frontend assets are served.`);
}

async function assertServedBundleMatchesDist(servedHtml) {
  const localIndexPath = join(root, 'web', 'dist', 'index.html');
  if (!existsSync(localIndexPath)) {
    console.log('SKIP local web/dist/index.html is missing; bundle freshness was not checked.');
    return;
  }

  const localHtml = readFileSync(localIndexPath, 'utf8');
  const localAssets = extractAssetRefs(localHtml);
  const servedAssets = extractAssetRefs(servedHtml);
  if (!localAssets.length || !servedAssets.length) {
    console.log('SKIP bundle freshness check could not find local or served Vite assets.');
    return;
  }

  const localKey = localAssets.join('\n');
  const servedKey = servedAssets.join('\n');
  assert(
    localKey === servedKey,
    [
      'The running EdgeBase runtime is serving a stale SPA bundle.',
      'Restart or reload `npm --prefix backend run dev` after the latest web build, then rerun runtime smoke.',
      `Local dist assets: ${localAssets.join(', ')}`,
      `Served assets: ${servedAssets.join(', ')}`,
    ].join('\n'),
  );

  console.log('PASS running EdgeBase runtime serves the latest local web/dist asset references.');
}

function extractAssetRefs(html) {
  const refs = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value) => !value.startsWith('data:'))
    .filter((value) => !value.startsWith('blob:'))
    .map((value) => value.replace(/[?#].*$/, ''))
    .filter((value) => value.includes('/assets/') || value.startsWith('assets/'))
    .map((value) => (value.startsWith('/') ? value : `/${value}`));

  return [...new Set(refs)];
}

function extensionOf(path) {
  const clean = path.replace(/[?#].*$/, '');
  const lastDot = clean.lastIndexOf('.');
  return lastDot === -1 ? '' : clean.slice(lastDot);
}

function looksLikeHtml(body) {
  return /<!doctype html/i.test(body) || /<html[\s>]/i.test(body) || /<div[^>]+id=["']root["']/.test(body);
}
