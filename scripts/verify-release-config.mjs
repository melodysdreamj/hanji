#!/usr/bin/env node

import { createRequire } from 'node:module';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeHanjiEnvironment,
  legacyHanjiEnvironmentNames,
} from './migrate-hanji-local-namespace.mjs';
import { verifyHanjiNamespace } from './verify-hanji-namespace.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = resolve(root, 'backend');
const webDir = resolve(root, 'web');
const requireFromBackend = createRequire(resolve(backendDir, 'package.json'));
const UPSTREAM_SPONSORS_FEED_URL =
  'https://hanji-sponsors-service.melodydreamj.workers.dev/sponsors';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_OAUTH_AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize';
const SSRF_DOH_URL = 'https://cloudflare-dns.com/dns-query';
const SUPPORTED_OAUTH_PROVIDERS = new Set([
  'apple',
  'discord',
  'facebook',
  'github',
  'google',
  'kakao',
  'line',
  'microsoft',
  'naver',
  'reddit',
  'slack',
  'spotify',
  'twitch',
  'x',
]);
const DANGEROUS_RELEASE_ENVIRONMENT_NAMES = [
  'EDGEBASE_CONFIG',
  'EDGEBASE_TEST',
  'EDGEBASE_TEST_BUILD',
  'EDGEBASE_LOCAL_DEV_BUILD',
  'EDGEBASE_USE_TEST_CONFIG',
  'EDGEBASE_DEV_SIDECAR_PORT',
  'EDGEBASE_INTERNAL_WORKER_URL',
  'EDGEBASE_SMS_API_URL',
  'EDGEBASE_CONFIG_ENV_ALLOWLIST',
  'EDGEBASE_RUNTIME_MODE',
  'EDGEBASE_USE_RAW_WRANGLER_DEV',
  'EDGEBASE_EMAIL_API_URL',
  'EDGEBASE_APP_WEB_VERIFY_EMAIL_URL',
  'EDGEBASE_APP_WEB_RESET_PASSWORD_URL',
  'EDGEBASE_APP_WEB_MAGIC_LINK_URL',
  'EDGEBASE_APP_WEB_CHANGE_EMAIL_URL',
  // Product-level aliases bypass the canonical Hanji validation below.
  'EDGEBASE_APP_ORIGIN',
  'EDGEBASE_PASSKEY_RP_ID',
  'EDGEBASE_PASSKEY_ORIGINS',
  'EDGEBASE_EMAIL_FROM',
  'EDGEBASE_EMAIL_PROVIDER',
  'EDGEBASE_EMAIL_CLOUDFLARE_API_TOKEN',
  'EDGEBASE_EMAIL_API_KEY',
  'EDGEBASE_EMAIL_CLOUDFLARE_ACCOUNT_ID',
  'EDGEBASE_EMAIL_CLOUDFLARE_BINDING',
  'EDGEBASE_AUTH_ALLOWED_OAUTH_PROVIDERS',
  'EDGEBASE_MASTER_EMAIL',
  'EDGEBASE_MASTER_PASSWORD',
  'EDGEBASE_INSTANCE_ADMIN_USER_IDS',
  'EDGEBASE_INSTANCE_ADMIN_EMAILS',
  'EDGEBASE_STRICT_INSTANCE_ADMINS',
  'EDGEBASE_JWT_SECRET',
  'HANJI_MCP_JWT_SECRET',
  'HANJI_MCP_OAUTH_ALLOW_DEV_SECRET',
  'HANJI_MCP_PUBLIC_ORIGIN',
];
const STRICT_RELEASE_FILE_KEYS = [
  'JWT_USER_SECRET',
  'JWT_ADMIN_SECRET',
  'JWT_USER_SECRET_OLD',
  'JWT_USER_SECRET_OLD_AT',
  'JWT_ADMIN_SECRET_OLD',
  'JWT_ADMIN_SECRET_OLD_AT',
  'HANJI_NOTION_IMPORT_SECRET',
  'HANJI_MCP_OAUTH_SECRET',
  'HANJI_APP_ORIGIN',
  'HANJI_AUTH_EMAIL_FROM',
  'HANJI_PASSKEY_RP_ID',
  'HANJI_PASSKEY_ORIGINS',
  'HANJI_CLOUDFLARE_EMAIL_BINDING',
  'HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID',
  'HANJI_CLOUDFLARE_EMAIL_API_TOKEN',
  'HANJI_BROWSER_SETUP',
  'HANJI_BROWSER_SETUP_TOKEN',
  'HANJI_TRUST_SELF_HOSTED_PROXY',
  'HANJI_MASTER_EMAIL',
  'HANJI_MASTER_PASSWORD',
  'HANJI_INSTANCE_ADMIN_USER_IDS',
  'HANJI_BUILD_SHA',
  'HANJI_SOURCE_URL',
  'HANJI_AGPL_LICENSE_URL',
  'HANJI_SPONSOR_EXCEPTION_URL',
  // These exact safe values overwrite any stale hosted Worker secrets.
  'HANJI_NOTION_API_BASE',
  'HANJI_NOTION_OAUTH_AUTH_URL',
  'HANJI_NOTION_OAUTH_CLIENT_ID',
  'HANJI_NOTION_OAUTH_CLIENT_SECRET',
  'HANJI_NOTION_OAUTH_REDIRECT_URI',
  'HANJI_NOTION_OAUTH_STATE_SECRET',
  'HANJI_NOTION_OAUTH_ENABLED',
  'HANJI_AUTH_OAUTH_PROVIDERS',
  'HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS',
  'HANJI_SSRF_DOH_URL',
  'HANJI_SSRF_DNS_CHECK',
  'HANJI_RATE_LIMIT_PROFILE',
  'HANJI_ALLOW_DEV_GUEST_LOGIN',
  'HANJI_MASTER_DEV_AUTOLOGIN',
  'HANJI_SPONSORS_FEED_URL',
  'HANJI_DEBUG_ROOM_ACCESS',
  'HANJI_MCP_TRUST_PROXY_HEADERS',
];
export const LEGAL_URL_NAMES = [
  'HANJI_SOURCE_URL',
  'HANJI_AGPL_LICENSE_URL',
  'HANJI_SPONSOR_EXCEPTION_URL',
];

const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv6');
}

export function parseEnvFile(text) {
  const values = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid environment assignment on line ${index + 1}.`);
    }
    const name = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      throw new Error(`Invalid environment variable name on line ${index + 1}: ${name}`);
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

export function hostedEmailBindingConfigured(source, binding = 'EMAIL') {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source
    .split(/^\s*\[\[send_email\]\]\s*$/m)
    .slice(1)
    .some((block) => {
      const body = block.split(/^\s*\[/m, 1)[0];
      return new RegExp(`^\\s*name\\s*=\\s*["']${escaped}["']\\s*(?:#.*)?$`, 'm').test(body);
    });
}

export function runtimeProcessEnvCompatibilityConfigured(source) {
  const match = source.match(/^\s*compatibility_flags\s*=\s*\[([^\]]*)\]/m);
  if (!match) return false;
  const flags = new Set(
    [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]),
  );
  return flags.has('nodejs_compat') && flags.has('nodejs_compat_populate_process_env');
}

export function publicGitCheckoutState() {
  const headResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const statusResult = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const head = headResult.status === 0 ? headResult.stdout.trim() : '';
  return {
    head: /^[a-f0-9]{40,64}$/i.test(head) ? head : '',
    status: statusResult.status === 0 ? statusResult.stdout : null,
  };
}

export function strictGitCheckoutErrors(checkoutState) {
  if (!checkoutState?.head || checkoutState.status === null) {
    return ['Strict release mode must run from a readable public Git checkout.'];
  }
  if (checkoutState.status) {
    return ['Strict release mode requires a clean public Git worktree; commit or remove every public change first.'];
  }
  return [];
}

export function strictReleaseEnvFileErrors(envFile, fileEnv) {
  const errors = [];
  let stat;
  try {
    stat = lstatSync(envFile);
  } catch {
    return [`Strict release mode requires a regular ${envFile} file with mode 0600 or read-only 0400.`];
  }
  if (!stat.isFile()) {
    errors.push(`Strict release mode requires ${envFile} to be a regular file, not a symlink or directory.`);
  }
  const permissionBits = stat.mode & 0o777;
  if (![0o400, 0o600].includes(permissionBits)) {
    errors.push(`Strict release mode requires ${envFile} permissions to be 0600 or read-only 0400.`);
  }
  for (const name of STRICT_RELEASE_FILE_KEYS) {
    if (!Object.hasOwn(fileEnv, name)) {
      errors.push(`${name} must be declared in ${envFile}; its value may be overridden by the invoking environment.`);
    }
  }
  return errors;
}

const VITE_PRODUCTION_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
];

/**
 * Vite exposes every VITE_* value to browser JavaScript. Hanji's production
 * browser/API contract is same-origin, so a production-loaded Vite env file is
 * never allowed to supply one. Development-only files are intentionally not
 * scanned because Vite does not load them for a production build.
 */
export function viteProductionEnvironmentErrors(directory = webDir) {
  const errors = [];
  for (const name of VITE_PRODUCTION_ENV_FILES) {
    const path = resolve(directory, name);
    if (!existsSync(path)) continue;
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      errors.push(`Could not inspect production-loaded Vite environment file ${path}.`);
      continue;
    }
    if (!stat.isFile()) {
      errors.push(`Production-loaded Vite environment path ${path} must be a regular file, not a symlink or directory.`);
      continue;
    }
    if (stat.size > 64 * 1024) {
      errors.push(`Production-loaded Vite environment file ${path} exceeds the 64 KiB safety limit.`);
      continue;
    }
    try {
      const parsed = parseEnvFile(readFileSync(path, 'utf8'));
      const publicNames = Object.keys(parsed).filter((key) => key.startsWith('VITE_'));
      if (publicNames.length) {
        errors.push(
          `${path} defines browser-exposed production variable(s): ${publicNames.join(', ')}. `
          + 'Move local-only values to .env.development.local; Hanji release builds are same-origin.',
        );
      }
    } catch (error) {
      errors.push(
        `Could not safely parse production-loaded Vite environment file ${path}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

export function releaseModeEnabled(source, typescript) {
  const file = typescript.createSourceFile(
    'edgebase.config.ts',
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );

  for (const statement of file.statements) {
    if (!typescript.isExportAssignment(statement)) continue;
    const call = statement.expression;
    if (!typescript.isCallExpression(call) || call.arguments.length !== 1) continue;
    if (!typescript.isIdentifier(call.expression) || call.expression.text !== 'defineConfig') continue;
    const config = call.arguments[0];
    if (!typescript.isObjectLiteralExpression(config)) continue;
    const property = config.properties.find((candidate) =>
      typescript.isPropertyAssignment(candidate) &&
      ((typescript.isIdentifier(candidate.name) && candidate.name.text === 'release') ||
        (typescript.isStringLiteral(candidate.name) && candidate.name.text === 'release')),
    );
    return Boolean(
      property &&
      typescript.isPropertyAssignment(property) &&
      property.initializer.kind === typescript.SyntaxKind.TrueKeyword,
    );
  }
  return false;
}

function objectProperty(object, name, typescript) {
  if (!object || !typescript.isObjectLiteralExpression(object)) return null;
  const property = object.properties.find((candidate) =>
    typescript.isPropertyAssignment(candidate) &&
    ((typescript.isIdentifier(candidate.name) && candidate.name.text === name) ||
      (typescript.isStringLiteral(candidate.name) && candidate.name.text === name)),
  );
  return property && typescript.isPropertyAssignment(property) ? property.initializer : null;
}

function defineConfigObject(source, typescript) {
  const file = typescript.createSourceFile(
    'edgebase.config.ts',
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  for (const statement of file.statements) {
    if (!typescript.isExportAssignment(statement)) continue;
    const call = statement.expression;
    if (!typescript.isCallExpression(call) || call.arguments.length !== 1) continue;
    if (!typescript.isIdentifier(call.expression) || call.expression.text !== 'defineConfig') continue;
    const config = call.arguments[0];
    if (typescript.isObjectLiteralExpression(config)) return config;
  }
  return null;
}

export function secureBrowserSessionConfigured(source, typescript) {
  const config = defineConfigObject(source, typescript);
  const auth = objectProperty(config, 'auth', typescript);
  const session = objectProperty(auth, 'session', typescript);
  const cookie = objectProperty(session, 'cookie', typescript);
  const enabled = objectProperty(cookie, 'enabled', typescript);
  const name = objectProperty(cookie, 'name', typescript);
  const sameSite = objectProperty(cookie, 'sameSite', typescript);
  const cors = objectProperty(config, 'cors', typescript);
  const credentials = objectProperty(cors, 'credentials', typescript);
  const origins = objectProperty(cors, 'origin', typescript);

  if (enabled?.kind !== typescript.SyntaxKind.TrueKeyword) return false;
  if (!name || !typescript.isStringLiteral(name) || !name.text.trim()) return false;
  if (!sameSite || !typescript.isStringLiteral(sameSite) || sameSite.text !== 'strict') return false;
  if (credentials?.kind !== typescript.SyntaxKind.TrueKeyword) return false;
  if (!origins || !typescript.isArrayLiteralExpression(origins)) return false;
  return origins.elements.every((origin) => {
    // APP_ORIGIN is production-validated below as an exact public HTTPS origin
    // and is the only dynamic credential origin accepted by this guard.
    if (typescript.isIdentifier(origin) && origin.text === 'APP_ORIGIN') return true;
    if (!typescript.isStringLiteral(origin) || origin.text.includes('*')) return false;
    try {
      const parsed = new URL(origin.text);
      return (
        ['http:', 'https:'].includes(parsed.protocol) &&
        parsed.origin === origin.text &&
        parsed.pathname === '/' &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  });
}

function value(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

function normalizedHostname(input) {
  return input.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
}

function isReservedHostname(hostname) {
  return (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /(?:^|\.)(?:alt|arpa|corp|home|internal|invalid|lan|local|onion|test)$/.test(hostname) ||
    /^(?:.+\.)?example\.(?:com|org|net)$/.test(hostname)
  );
}

function isPublicIpAddress(address) {
  const normalized = normalizedHostname(address);
  if (
    /^::ffff:/i.test(normalized) ||
    /^::(?:\d{1,3}\.){3}\d{1,3}$/i.test(normalized) ||
    /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(normalized)
  ) {
    return false;
  }
  const family = isIP(normalized);
  if (family === 4) return !nonPublicAddresses.check(normalized, 'ipv4');
  if (family === 6) return !nonPublicAddresses.check(normalized, 'ipv6');
  return false;
}

function isPublicHttpsUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = normalizedHostname(url.hostname);
    if (
      isReservedHostname(hostname) ||
      (isIP(hostname) > 0 && !isPublicIpAddress(hostname)) ||
      (isIP(hostname) === 0 && !isPublicDomainName(hostname))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function publicHttpsOrigin(input) {
  if (!isPublicHttpsUrl(input)) return null;
  try {
    const url = new URL(input);
    // An origin has no path/query/fragment and is written in canonical form.
    // Requiring the exact serialization also rejects ambiguous trailing slashes
    // and normalized default-port spellings in security-sensitive allowlists.
    return input === url.origin && url.pathname === '/' && !url.search && !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

function isPublicDomainName(input) {
  if (!input || input !== input.toLowerCase() || input !== normalizedHostname(input)) return false;
  if (isIP(input) || isReservedHostname(input) || input.length > 253 || !input.includes('.')) return false;
  const labels = input.split('.');
  return labels.every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

function isDeliverableEmail(input) {
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(input)) return false;
  const separator = input.lastIndexOf('@');
  const domain = input.slice(separator + 1).toLowerCase();
  return input.slice(separator + 1) === domain && isPublicDomainName(domain);
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertPublicResolution(url, resolveHost, timeoutMs) {
  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new Error('non-public address');
    return;
  }

  const resolved = await withTimeout(
    resolveHost(hostname, { all: true, verbatim: true }),
    timeoutMs,
  );
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !entry?.address || !isPublicIpAddress(entry.address))
  ) {
    throw new Error('non-public address');
  }
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await withTimeout(
      Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal })),
      timeoutMs,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function discardResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The status and headers are enough for this bounded reachability probe.
  }
}

async function readBoundedResponseText(response, maxBytes = 64 * 1024, timeoutMs = 8_000) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const readSample = async () => {
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (!chunk?.byteLength) continue;
      const remaining = maxBytes - total;
      const accepted = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(accepted);
      total += accepted.byteLength;
      if (accepted.byteLength < chunk.byteLength) break;
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  };
  try {
    return await withTimeout(readSample(), timeoutMs);
  } finally {
    // Do not await cancellation: a broken stream must not extend the deadline.
    void reader.cancel().catch(() => undefined);
  }
}

async function probePublicUrl(
  input,
  { fetchImpl, resolveHost, timeoutMs, maxRedirects },
) {
  const probeHeaders = {
    Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
    'User-Agent': 'Hanji-Release-Preflight/1.0',
  };
  let current = new URL(input);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (!isPublicHttpsUrl(current.toString())) throw new Error('non-public URL');
    await assertPublicResolution(current, resolveHost, timeoutMs);

    const headResponse = await fetchWithTimeout(
      fetchImpl,
      current,
      { method: 'HEAD', redirect: 'manual', headers: probeHeaders },
      timeoutMs,
    );
    if (headResponse.status >= 300 && headResponse.status < 400) {
      const location = headResponse.headers.get('location');
      await discardResponse(headResponse);
      if (!location || redirectCount === maxRedirects) throw new Error('invalid redirect');
      current = new URL(location, current);
      continue;
    }
    await discardResponse(headResponse);

    const response = await fetchWithTimeout(
      fetchImpl,
      current,
      {
        method: 'GET',
        redirect: 'manual',
        headers: { ...probeHeaders, Range: 'bytes=0-65535' },
      },
      timeoutMs,
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await discardResponse(response);
      if (!location || redirectCount === maxRedirects) throw new Error('invalid redirect');
      current = new URL(location, current);
      continue;
    }
    if (response.status >= 200 && response.status < 300 && response.status !== 204) {
      return {
        finalUrl: current.toString(),
        body: await readBoundedResponseText(response, 64 * 1024, timeoutMs),
      };
    }

    await discardResponse(response);
    throw new Error('unsuccessful status');
  }
  throw new Error('too many redirects');
}

export async function verifyLegalUrlsReachable(
  env,
  {
    fetchImpl = globalThis.fetch,
    resolveHost = dnsLookup,
    timeoutMs = 8_000,
    maxRedirects = 5,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Strict release preflight requires a fetch implementation.');
  }

  const probes = await Promise.all(
    LEGAL_URL_NAMES.map(async (name) => {
      const configured = value(env, name);
      if (!configured || !isPublicHttpsUrl(configured)) return { name, error: null, probe: null };
      try {
        const probe = await probePublicUrl(configured, { fetchImpl, resolveHost, timeoutMs, maxRedirects });
        const body = probe.body.trim();
        if (!body) throw new Error('empty body');
        const normalizedBody = body.toUpperCase();
        if (
          name === 'HANJI_AGPL_LICENSE_URL' &&
          (!normalizedBody.includes('GNU AFFERO GENERAL PUBLIC LICENSE') || !normalizedBody.includes('VERSION 3'))
        ) {
          throw new Error('AGPL marker missing');
        }
        if (
          name === 'HANJI_SPONSOR_EXCEPTION_URL' &&
          (!normalizedBody.includes('HANJI SPONSOR BANNER EXCEPTION') || !normalizedBody.includes('AGPL-3.0'))
        ) {
          throw new Error('exception marker missing');
        }
        return { name, error: null, probe };
      } catch {
        return {
          name,
          error: `${name} must resolve only to public addresses and return a non-empty successful HTTPS artifact with the expected legal markers.`,
          probe: null,
        };
      }
    }),
  );
  const errors = probes.map((result) => result.error).filter(Boolean);
  const finalUrls = new Map();
  for (const result of probes) {
    if (!result.probe) continue;
    const canonical = new URL(result.probe.finalUrl);
    canonical.hash = '';
    const duplicateOf = finalUrls.get(canonical.toString());
    if (duplicateOf) {
      errors.push(`${result.name} must not redirect to the same final artifact as ${duplicateOf}.`);
    } else {
      finalUrls.set(canonical.toString(), result.name);
    }
  }
  return { errors };
}

export async function verifyProductionOriginsResolve(
  env,
  { resolveHost = dnsLookup, timeoutMs = 8_000 } = {},
) {
  env = canonicalizeHanjiEnvironment(env);
  const candidates = [
    ['HANJI_APP_ORIGIN', value(env, 'HANJI_APP_ORIGIN')],
    ...value(env, 'HANJI_PASSKEY_ORIGINS')
      .split(',')
      .map((origin) => ['HANJI_PASSKEY_ORIGINS', origin.trim()])
      .filter(([, origin]) => origin),
  ];
  const errors = [];
  for (const [name, input] of candidates) {
    const origin = publicHttpsOrigin(input);
    if (!origin) continue;
    try {
      await assertPublicResolution(origin, resolveHost, timeoutMs);
    } catch {
      errors.push(`${name} must resolve only to public IP addresses in strict release mode.`);
    }
  }
  return { errors };
}

function isPlaceholder(input) {
  return (
    /^(?:change[-_ ]?me|replace[-_ ]?(?:me|this|with.*)|todo|example|secret|xxx+|<.+>)$/i.test(input) ||
    /^(?:your|my)[-_ ]?(?:secret|token|password|key)$/i.test(input)
  );
}

function looksCryptographicallyRandom(input, minimum) {
  if (
    !input ||
    input.length < minimum ||
    isPlaceholder(input) ||
    /[\s\u0000-\u001f\u007f]/.test(input) ||
    new Set(input).size < 8
  ) {
    return false;
  }
  for (let patternLength = 1; patternLength <= Math.min(16, input.length / 2); patternLength += 1) {
    if (input === input.slice(0, patternLength).repeat(input.length / patternLength)) return false;
  }
  return true;
}

export function validateProductionEnvironment(
  env,
  {
    requireLegalUrls = false,
    hostedEmailBindingProven = false,
    expectedBuildSha = '',
    now = Date.now(),
  } = {},
) {
  const legacyEnvironmentNames = legacyHanjiEnvironmentNames(env);
  env = canonicalizeHanjiEnvironment(env);
  const errors = [];
  const warnings = [];
  if (legacyEnvironmentNames.length) {
    errors.push(
      `Pre-Hanji environment variable names are not permitted for a release (${legacyEnvironmentNames.join(', ')}); migrate them to HANJI_* names.`,
    );
  }
  for (const name of DANGEROUS_RELEASE_ENVIRONMENT_NAMES) {
    if (Object.hasOwn(env, name)) {
      errors.push(`${name} is a development/runtime override and must not be supplied to release preflight.`);
    }
  }
  for (const name of Object.keys(env)) {
    const rawProviderCredential = [...SUPPORTED_OAUTH_PROVIDERS].some((provider) => {
      const prefix = provider.toUpperCase();
      return name === `${prefix}_CLIENT_ID` || name === `${prefix}_CLIENT_SECRET`;
    });
    if (name.startsWith('EDGEBASE_OAUTH_') || rawProviderCredential) {
      errors.push(`${name} is a non-canonical OAuth alias; release configuration must use HANJI_OAUTH_* names only.`);
    }
  }
  for (const name of Object.keys(env).filter((candidate) => candidate.startsWith('VITEST'))) {
    errors.push(`${name} is a test-runner override and must not be supplied to release preflight.`);
  }
  for (const name of Object.keys(env).filter((candidate) => candidate.startsWith('VITE_'))) {
    errors.push(
      `${name} is a browser-exposed build override and must not be supplied to release preflight; `
      + 'Hanji release builds use the current origin for API and authentication traffic.',
    );
  }
  const nodeEnvironment = value(env, 'NODE_ENV').toLowerCase();
  if (nodeEnvironment && nodeEnvironment !== 'production') {
    errors.push('NODE_ENV must be production when it is explicitly set for a release deploy.');
  }
  const debugRoomAccess = value(env, 'HANJI_DEBUG_ROOM_ACCESS').toLowerCase();
  if (requireLegalUrls && !['0', 'false'].includes(debugRoomAccess)) {
    errors.push('HANJI_DEBUG_ROOM_ACCESS must be explicitly set to 0 or false in strict release mode.');
  } else if (debugRoomAccess && debugRoomAccess !== '0' && debugRoomAccess !== 'false') {
    errors.push('HANJI_DEBUG_ROOM_ACCESS must be exactly 0 or false for a release deploy.');
  }
  const mcpTrustProxyHeaders = value(env, 'HANJI_MCP_TRUST_PROXY_HEADERS').toLowerCase();
  if (requireLegalUrls && !['0', 'false'].includes(mcpTrustProxyHeaders)) {
    errors.push('HANJI_MCP_TRUST_PROXY_HEADERS must be explicitly set to false or 0 in strict release mode.');
  } else if (mcpTrustProxyHeaders && mcpTrustProxyHeaders !== 'false' && mcpTrustProxyHeaders !== '0') {
    errors.push('HANJI_MCP_TRUST_PROXY_HEADERS must be exactly false or 0 for a release deploy.');
  }
  const ssrfDohUrl = value(env, 'HANJI_SSRF_DOH_URL');
  if (requireLegalUrls && ssrfDohUrl !== SSRF_DOH_URL) {
    errors.push(`HANJI_SSRF_DOH_URL must be explicitly set to ${SSRF_DOH_URL} in strict release mode.`);
  } else if (ssrfDohUrl && ssrfDohUrl !== SSRF_DOH_URL) {
    errors.push(`HANJI_SSRF_DOH_URL must be exactly ${SSRF_DOH_URL} for a release deploy.`);
  }
  const devGuestLogin = value(env, 'HANJI_ALLOW_DEV_GUEST_LOGIN').toLowerCase();
  if (requireLegalUrls && !['0', 'false'].includes(devGuestLogin)) {
    errors.push('HANJI_ALLOW_DEV_GUEST_LOGIN must be explicitly set to false or 0 in strict release mode.');
  } else if (['1', 'true', 'yes', 'on'].includes(devGuestLogin)) {
    errors.push('HANJI_ALLOW_DEV_GUEST_LOGIN must be disabled for a release deploy.');
  }
  const legacyAnonymousBootstrap = value(env, 'HANJI_ALLOW_ANONYMOUS_BOOTSTRAP').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(legacyAnonymousBootstrap)) {
    errors.push(
      'HANJI_ALLOW_ANONYMOUS_BOOTSTRAP is retired and must not enable anonymous bootstrap in a release deploy; use HANJI_ALLOW_DEV_GUEST_LOGIN only for explicit local development.',
    );
  }
  const masterDevAutoLogin = value(env, 'HANJI_MASTER_DEV_AUTOLOGIN').toLowerCase();
  if (requireLegalUrls && !['0', 'false'].includes(masterDevAutoLogin)) {
    errors.push('HANJI_MASTER_DEV_AUTOLOGIN must be explicitly set to false or 0 in strict release mode.');
  } else if (['1', 'true', 'yes', 'on'].includes(masterDevAutoLogin)) {
    errors.push(
      'HANJI_MASTER_DEV_AUTOLOGIN is retired and must be disabled for a release deploy.',
    );
  }
  const trustSelfHostedProxy = value(env, 'HANJI_TRUST_SELF_HOSTED_PROXY').toLowerCase();
  if (requireLegalUrls && !['0', 'false'].includes(trustSelfHostedProxy)) {
    errors.push('HANJI_TRUST_SELF_HOSTED_PROXY must be explicitly set to false or 0 in strict release mode.');
  } else if (['1', 'true', 'yes', 'on'].includes(trustSelfHostedProxy)) {
    errors.push('HANJI_TRUST_SELF_HOSTED_PROXY is reserved for the self-hosted Docker reverse-proxy boundary.');
  }
  const ssrfDnsCheck = value(env, 'HANJI_SSRF_DNS_CHECK').toLowerCase();
  if (requireLegalUrls && ssrfDnsCheck !== 'on') {
    errors.push('HANJI_SSRF_DNS_CHECK must be explicitly set to on in strict release mode.');
  } else if (ssrfDnsCheck === 'off' || ssrfDnsCheck === 'false' || ssrfDnsCheck === '0') {
    errors.push(
      'HANJI_SSRF_DNS_CHECK must remain enabled for a release deploy; disabling DNS verification permits hostname-based SSRF.',
    );
  }
  const rateLimitProfile = value(env, 'HANJI_RATE_LIMIT_PROFILE').toLowerCase();
  if (requireLegalUrls && rateLimitProfile !== 'production') {
    errors.push('HANJI_RATE_LIMIT_PROFILE must be explicitly set to production in strict release mode.');
  } else if (rateLimitProfile && rateLimitProfile !== 'production') {
    errors.push('HANJI_RATE_LIMIT_PROFILE must be production for a release deploy.');
  }
  const configuredSecrets = new Map();
  const registerSecret = (name) => {
    const input = value(env, name);
    if (input) configuredSecrets.set(name, input);
    return input;
  };
  const requireStrongSecret = (name, minimum = 32) => {
    const input = registerSecret(name);
    if (!looksCryptographicallyRandom(input, minimum)) {
      errors.push(
        `${name} must be an independently generated, non-placeholder secret of at least ${minimum} characters.`,
      );
    }
  };

  requireStrongSecret('JWT_USER_SECRET');
  requireStrongSecret('JWT_ADMIN_SECRET');
  requireStrongSecret('HANJI_NOTION_IMPORT_SECRET');
  requireStrongSecret('HANJI_MCP_OAUTH_SECRET');

  for (const prefix of ['JWT_USER_SECRET', 'JWT_ADMIN_SECRET']) {
    const oldSecretName = `${prefix}_OLD`;
    const rotatedAtName = `${prefix}_OLD_AT`;
    const oldSecret = value(env, oldSecretName);
    const rotatedAt = value(env, rotatedAtName);
    if (Boolean(oldSecret) !== Boolean(rotatedAt)) {
      errors.push(`${oldSecretName} and ${rotatedAtName} must be configured or removed together.`);
      continue;
    }
    if (!oldSecret) continue;
    requireStrongSecret(oldSecretName);
    const rotatedAtMs = Date.parse(rotatedAt);
    const canonicalTimestamp = Number.isFinite(rotatedAtMs)
      ? new Date(rotatedAtMs).toISOString()
      : '';
    if (!canonicalTimestamp || canonicalTimestamp !== rotatedAt) {
      errors.push(`${rotatedAtName} must be a canonical UTC ISO-8601 timestamp.`);
    } else if (rotatedAtMs > now) {
      errors.push(`${rotatedAtName} must not be in the future.`);
    } else if (now - rotatedAtMs > 28 * 24 * 60 * 60 * 1000) {
      errors.push(`${oldSecretName} has exceeded the 28-day rotation grace period and must be removed with ${rotatedAtName}.`);
    }
  }

  const appOriginInput = value(env, 'HANJI_APP_ORIGIN');
  const appOrigin = publicHttpsOrigin(appOriginInput);
  if (!appOrigin) {
    errors.push(
      'HANJI_APP_ORIGIN must be one exact canonical public HTTPS origin without credentials, a trailing slash, path, query, or fragment.',
    );
  }

  const rpIdInput = value(env, 'HANJI_PASSKEY_RP_ID');
  const passkeyOriginsInput = value(env, 'HANJI_PASSKEY_ORIGINS');
  if (rpIdInput || passkeyOriginsInput) {
    if (!rpIdInput || !passkeyOriginsInput) {
      errors.push(
        'HANJI_PASSKEY_RP_ID and HANJI_PASSKEY_ORIGINS must be configured together when preparing the currently disabled passkey feature.',
      );
    }
    const rpId = rpIdInput.toLowerCase();
    if (rpIdInput !== rpId || !isPublicDomainName(rpId)) {
      errors.push('HANJI_PASSKEY_RP_ID must be one canonical, non-reserved public DNS domain.');
    } else if (appOrigin && appOrigin.hostname !== rpId && !appOrigin.hostname.endsWith(`.${rpId}`)) {
      errors.push('HANJI_PASSKEY_RP_ID must equal or be a parent-domain suffix of the app hostname.');
    }

    const passkeyOrigins = passkeyOriginsInput
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const seenPasskeyOrigins = new Set();
    for (const origin of passkeyOrigins) {
      if (!publicHttpsOrigin(origin)) {
        errors.push(
          'HANJI_PASSKEY_ORIGINS entries must be exact canonical public HTTPS origins without credentials, trailing slashes, paths, queries, or fragments.',
        );
      }
      if (seenPasskeyOrigins.has(origin)) {
        errors.push('HANJI_PASSKEY_ORIGINS must not contain duplicate origins.');
      }
      seenPasskeyOrigins.add(origin);
    }
    if (appOrigin && !passkeyOrigins.includes(appOrigin.origin)) {
      errors.push('HANJI_PASSKEY_ORIGINS must include HANJI_APP_ORIGIN.');
    }
  }

  const emailFrom = value(env, 'HANJI_AUTH_EMAIL_FROM');
  if (!isDeliverableEmail(emailFrom)) {
    errors.push('HANJI_AUTH_EMAIL_FROM must use a canonical, non-reserved public email domain.');
  }
  const emailBinding = value(env, 'HANJI_CLOUDFLARE_EMAIL_BINDING');
  const emailAccount = value(env, 'HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID');
  const emailToken = value(env, 'HANJI_CLOUDFLARE_EMAIL_API_TOKEN');
  if (emailBinding && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(emailBinding)) {
    errors.push('HANJI_CLOUDFLARE_EMAIL_BINDING must be a valid Workers binding identifier.');
  }
  const hostedBindingReady = emailBinding === 'EMAIL' && hostedEmailBindingProven;
  if (Boolean(emailAccount) !== Boolean(emailToken)) {
    errors.push(
      'HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID and HANJI_CLOUDFLARE_EMAIL_API_TOKEN must be configured together.',
    );
  }
  if (!hostedBindingReady && (!emailAccount || !emailToken)) {
    errors.push(
      'Configure both HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID and HANJI_CLOUDFLARE_EMAIL_API_TOKEN unless the exact EMAIL binding is proven by backend/wrangler.toml.',
    );
  }
  if (emailAccount && (!/^[a-f0-9]{32}$/i.test(emailAccount) || /^0{32}$/.test(emailAccount))) {
    errors.push('HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID must be an exact 32-character hexadecimal account ID.');
  }
  if (emailToken) {
    registerSecret('HANJI_CLOUDFLARE_EMAIL_API_TOKEN');
    if (!looksCryptographicallyRandom(emailToken, 40)) {
      errors.push('HANJI_CLOUDFLARE_EMAIL_API_TOKEN must be a strong non-placeholder token of at least 40 characters.');
    }
  }

  const notionJobRetentionDays = value(env, 'HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS');
  if (requireLegalUrls && !notionJobRetentionDays) {
    errors.push('HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS must explicitly select an integer from 1 to 365 in strict release mode.');
  } else if (
    notionJobRetentionDays
    && (!/^[1-9][0-9]*$/.test(notionJobRetentionDays)
      || Number(notionJobRetentionDays) > 365)
  ) {
    errors.push('HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS must be an integer from 1 to 365.');
  }

  const browserSetup = value(env, 'HANJI_BROWSER_SETUP').toLowerCase();
  const setupToken = value(env, 'HANJI_BROWSER_SETUP_TOKEN');
  const masterEmail = value(env, 'HANJI_MASTER_EMAIL');
  const masterPassword = value(env, 'HANJI_MASTER_PASSWORD');
  const legacyMasterConfigured = Boolean(masterEmail && masterPassword);
  if (Boolean(masterEmail) !== Boolean(masterPassword)) {
    errors.push(
      'HANJI_MASTER_EMAIL and HANJI_MASTER_PASSWORD must both be empty for browser setup, or both be set for legacy noninteractive provisioning.',
    );
  }
  if (requireLegalUrls && browserSetup !== 'true') {
    errors.push('HANJI_BROWSER_SETUP must be explicitly set to true in strict release mode.');
  } else if (browserSetup && browserSetup !== 'true') {
    errors.push('HANJI_BROWSER_SETUP must be exactly true when configured.');
  }
  if (!legacyMasterConfigured && browserSetup !== 'true') {
    errors.push('Enable HANJI_BROWSER_SETUP=true when master credentials are not configured.');
  }
  if (setupToken) registerSecret('HANJI_BROWSER_SETUP_TOKEN');
  if (!legacyMasterConfigured && (
    !looksCryptographicallyRandom(setupToken, 43) ||
    !/^[A-Za-z0-9_-]+$/.test(setupToken)
  )) {
    errors.push(
      'HANJI_BROWSER_SETUP_TOKEN must be an independently generated URL-safe secret of at least 43 characters for browser setup.',
    );
  } else if (setupToken && (
    !looksCryptographicallyRandom(setupToken, 43) ||
    !/^[A-Za-z0-9_-]+$/.test(setupToken)
  )) {
    errors.push('HANJI_BROWSER_SETUP_TOKEN must be a strong URL-safe secret of at least 43 characters when configured.');
  }
  if (masterEmail && !isDeliverableEmail(masterEmail)) {
    errors.push('HANJI_MASTER_EMAIL must use a canonical, non-reserved public email domain.');
  }
  if (masterPassword) {
    registerSecret('HANJI_MASTER_PASSWORD');
    if (
      !looksCryptographicallyRandom(masterPassword, 16) ||
      masterPassword.length > 256 ||
      !/[A-Z]/.test(masterPassword) ||
      !/[a-z]/.test(masterPassword) ||
      !/[0-9]/.test(masterPassword) ||
      !/[^A-Za-z0-9]/.test(masterPassword)
    ) {
      errors.push(
        'HANJI_MASTER_PASSWORD must be 16-256 characters with upper/lowercase letters, a number, a special character, no whitespace/control characters, and sufficient diversity.',
      );
    }
  }

  const adminIds = value(env, 'HANJI_INSTANCE_ADMIN_USER_IDS');
  const adminEmails = value(env, 'HANJI_INSTANCE_ADMIN_EMAILS');
  const legacyAdminEmails = value(env, 'EDGEBASE_INSTANCE_ADMIN_EMAILS');
  if (adminEmails || legacyAdminEmails) {
    errors.push(
      'Instance-admin email allowlists are retired because password-signup emails are unverified; use HANJI_MASTER_EMAIL or HANJI_INSTANCE_ADMIN_USER_IDS.',
    );
  }
  if (!adminIds && !legacyMasterConfigured && !(browserSetup === 'true' && setupToken)) {
    errors.push('Configure an explicit instance-admin user ID, browser setup, or legacy master credentials.');
  }
  if (requireLegalUrls && !adminIds) {
    errors.push('HANJI_INSTANCE_ADMIN_USER_IDS must explicitly be off or a comma-separated immutable user-ID list in strict release mode.');
  } else if (adminIds.toLowerCase() === 'off' && adminIds !== 'off') {
    errors.push('HANJI_INSTANCE_ADMIN_USER_IDS uses the exact lowercase off sentinel.');
  } else if (adminIds && adminIds !== 'off') {
    const parsedAdminIds = adminIds.split(',').map((item) => item.trim()).filter(Boolean);
    if (
      !parsedAdminIds.length ||
      parsedAdminIds.length !== new Set(parsedAdminIds).size ||
      parsedAdminIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id))
    ) {
      errors.push('HANJI_INSTANCE_ADMIN_USER_IDS must be exactly off or a unique comma-separated immutable user-ID list.');
    }
  }

  const oauthProviderMode = value(env, 'HANJI_AUTH_OAUTH_PROVIDERS');
  if (requireLegalUrls && !oauthProviderMode) {
    errors.push('HANJI_AUTH_OAUTH_PROVIDERS must explicitly be off or list supported providers in strict release mode.');
  }
  const oauthProviders = (oauthProviderMode === 'off' ? '' : oauthProviderMode)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const seenOauthProviders = new Set();
  for (const provider of oauthProviders) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(provider)) {
      errors.push(`Invalid OAuth provider name: ${provider}.`);
      continue;
    }
    if (!SUPPORTED_OAUTH_PROVIDERS.has(provider)) {
      errors.push(`Unsupported OAuth provider: ${provider}.`);
      continue;
    }
    if (seenOauthProviders.has(provider)) {
      errors.push(`Duplicate OAuth provider: ${provider}.`);
      continue;
    }
    seenOauthProviders.add(provider);
    const key = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const clientIdName = `HANJI_OAUTH_${key}_CLIENT_ID`;
    const clientSecretName = `HANJI_OAUTH_${key}_CLIENT_SECRET`;
    const clientId = value(env, clientIdName);
    if (!clientId || clientId.length < 8 || isPlaceholder(clientId) || /\s/.test(clientId)) {
      errors.push(`Missing OAuth client ID for ${provider}.`);
    }
    const clientSecret = registerSecret(clientSecretName);
    if (!looksCryptographicallyRandom(clientSecret, 24)) {
      errors.push(`OAuth client secret for ${provider} must be a strong non-placeholder value of at least 24 characters.`);
    }
  }

  const notionOauthFields = [
    'HANJI_NOTION_OAUTH_CLIENT_ID',
    'HANJI_NOTION_OAUTH_CLIENT_SECRET',
    'HANJI_NOTION_OAUTH_REDIRECT_URI',
    'HANJI_NOTION_OAUTH_STATE_SECRET',
  ];
  const configuredNotionOauth = notionOauthFields.filter((name) => value(env, name));
  const notionOauthEnabled = value(env, 'HANJI_NOTION_OAUTH_ENABLED');
  if (notionOauthEnabled && !['true', 'false'].includes(notionOauthEnabled)) {
    errors.push('HANJI_NOTION_OAUTH_ENABLED must be exactly true or false when set.');
  }
  if (requireLegalUrls && !['true', 'false'].includes(notionOauthEnabled)) {
    errors.push('HANJI_NOTION_OAUTH_ENABLED must explicitly select true or false in strict release mode.');
  }
  if (notionOauthEnabled === 'false' && configuredNotionOauth.length) {
    errors.push('Notion OAuth is disabled; keep all four HANJI_NOTION_OAUTH_* credential/redirect declarations empty.');
  } else if (notionOauthEnabled === 'true' && configuredNotionOauth.length !== notionOauthFields.length) {
    errors.push('Notion OAuth is enabled; set its client ID, client secret, redirect URI, and state secret together.');
  } else if (configuredNotionOauth.length && configuredNotionOauth.length !== notionOauthFields.length) {
    errors.push('Notion OAuth is partially configured; set its client ID, client secret, redirect URI, and state secret together.');
  }
  const notionApiOverride = value(env, 'HANJI_NOTION_API_BASE');
  if (requireLegalUrls && notionApiOverride !== NOTION_API_BASE) {
    errors.push(`HANJI_NOTION_API_BASE must be explicitly set to ${NOTION_API_BASE} in strict release mode.`);
  } else if (notionApiOverride && notionApiOverride !== NOTION_API_BASE) {
    errors.push(`HANJI_NOTION_API_BASE must be unset or exactly ${NOTION_API_BASE} for a release deploy.`);
  }
  const notionOauthAuthorizeOverride = value(env, 'HANJI_NOTION_OAUTH_AUTH_URL');
  if (requireLegalUrls && notionOauthAuthorizeOverride !== NOTION_OAUTH_AUTHORIZE_URL) {
    errors.push(
      `HANJI_NOTION_OAUTH_AUTH_URL must be explicitly set to ${NOTION_OAUTH_AUTHORIZE_URL} in strict release mode.`,
    );
  } else if (notionOauthAuthorizeOverride && notionOauthAuthorizeOverride !== NOTION_OAUTH_AUTHORIZE_URL) {
    errors.push(
      `HANJI_NOTION_OAUTH_AUTH_URL must be unset or exactly ${NOTION_OAUTH_AUTHORIZE_URL} for a release deploy.`,
    );
  }
  const notionOauthRedirectUri = value(env, 'HANJI_NOTION_OAUTH_REDIRECT_URI');
  if (notionOauthRedirectUri) {
    const expectedNotionRedirect = appOrigin
      ? `${appOrigin.origin}/?notion_import_oauth=1`
      : null;
    if (!expectedNotionRedirect || notionOauthRedirectUri !== expectedNotionRedirect) {
      errors.push(
        'HANJI_NOTION_OAUTH_REDIRECT_URI must exactly equal HANJI_APP_ORIGIN plus /?notion_import_oauth=1.',
      );
    }
  }
  if (configuredNotionOauth.length && notionOauthEnabled !== 'false') {
    const notionClientId = value(env, 'HANJI_NOTION_OAUTH_CLIENT_ID');
    if (!notionClientId || notionClientId.length < 8 || isPlaceholder(notionClientId) || /\s/.test(notionClientId)) {
      errors.push('HANJI_NOTION_OAUTH_CLIENT_ID must be a non-placeholder client identifier of at least 8 characters.');
    }
    const notionClientSecret = registerSecret('HANJI_NOTION_OAUTH_CLIENT_SECRET');
    if (!looksCryptographicallyRandom(notionClientSecret, 32)) {
      errors.push('HANJI_NOTION_OAUTH_CLIENT_SECRET must be a strong non-placeholder secret of at least 32 characters.');
    }
    const notionStateSecret = registerSecret('HANJI_NOTION_OAUTH_STATE_SECRET');
    if (!looksCryptographicallyRandom(notionStateSecret, 32)) {
      errors.push('HANJI_NOTION_OAUTH_STATE_SECRET must be an independently generated secret of at least 32 characters.');
    }
  }
  if (!configuredNotionOauth.length || notionOauthEnabled === 'false') {
    warnings.push('Notion OAuth is disabled; imports require a user-supplied integration token.');
  }

  const buildSha = value(env, 'HANJI_BUILD_SHA');
  if (!buildSha) {
    const message = 'HANJI_BUILD_SHA is unset; health output cannot identify the deployed revision.';
    if (requireLegalUrls) errors.push(`${message} It is required in strict release mode.`);
    else warnings.push(message);
  } else if (
    (requireLegalUrls && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(buildSha)) ||
    (!requireLegalUrls && !/^[a-f0-9]{7,64}$/i.test(buildSha)) ||
    /^0+$/.test(buildSha)
  ) {
    errors.push(
      requireLegalUrls
        ? 'HANJI_BUILD_SHA must be a full 40- or 64-character immutable Git object ID in strict release mode.'
        : 'HANJI_BUILD_SHA must be a 7-64 character hexadecimal source revision.',
    );
  } else if (expectedBuildSha && buildSha.toLowerCase() !== expectedBuildSha.toLowerCase()) {
    errors.push('HANJI_BUILD_SHA must exactly match the current public Git HEAD for this release checkout.');
  }

  const secretOwners = new Map();
  for (const [name, secret] of configuredSecrets) {
    const duplicateOf = secretOwners.get(secret);
    if (duplicateOf) {
      errors.push(`${name} must be independently generated and must not equal ${duplicateOf}.`);
    } else {
      secretOwners.set(secret, name);
    }
  }

  for (const name of LEGAL_URL_NAMES) {
    const configured = value(env, name);
    if (!configured && requireLegalUrls) {
      errors.push(`${name} is required in strict release mode.`);
    } else if (configured && !isPublicHttpsUrl(configured)) {
      errors.push(`${name} must be a public HTTPS URL without embedded credentials.`);
    }
  }
  const sourceUrl = value(env, 'HANJI_SOURCE_URL');
  if (
    requireLegalUrls &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(buildSha) &&
    sourceUrl &&
    isPublicHttpsUrl(sourceUrl)
  ) {
    const sourcePath = new URL(sourceUrl).pathname.toLowerCase();
    if (!sourcePath.includes(buildSha.toLowerCase())) {
      errors.push('HANJI_SOURCE_URL must identify the exact full HANJI_BUILD_SHA in its HTTPS path.');
    }
  }
  const seenLegalUrls = new Map();
  for (const name of LEGAL_URL_NAMES) {
    const configured = value(env, name);
    if (!configured || !isPublicHttpsUrl(configured)) continue;
    const canonicalUrl = new URL(configured);
    // Fragments are never sent in the HTTP request and cannot turn one
    // response into three distinct legal artifacts.
    canonicalUrl.hash = '';
    const canonical = canonicalUrl.toString();
    const duplicateOf = seenLegalUrls.get(canonical);
    if (duplicateOf) {
      errors.push(`${name} must not duplicate ${duplicateOf}; source and license links are distinct artifacts.`);
    } else {
      seenLegalUrls.set(canonical, name);
    }
  }
  if (!requireLegalUrls && LEGAL_URL_NAMES.every((name) => !value(env, name))) {
    warnings.push(
      'Legal/source links use the upstream Hanji defaults; modified deployments must point them at the exact public Corresponding Source revision.',
    );
  }

  const sponsorsFeed = value(env, 'HANJI_SPONSORS_FEED_URL');
  if (requireLegalUrls && !sponsorsFeed) {
    errors.push(
      'HANJI_SPONSORS_FEED_URL must explicitly select the exact upstream feed, bundled, or off in strict release mode.',
    );
  }
  if (
    sponsorsFeed &&
    sponsorsFeed.toLowerCase() !== 'off' &&
    sponsorsFeed.toLowerCase() !== 'bundled' &&
    sponsorsFeed !== UPSTREAM_SPONSORS_FEED_URL
  ) {
    errors.push(
      'HANJI_SPONSORS_FEED_URL may be unset, bundled, off, or the exact upstream Hanji sponsor feed; replacement feeds are not permitted by the release contract.',
    );
  }

  return { errors, warnings };
}

export async function runPreflight({
  requireEnv = false,
  strictRelease = false,
  envFile = resolve(backendDir, '.env.release'),
  runtimeEnv = process.env,
  fetchImpl = globalThis.fetch,
  resolveHost = dnsLookup,
  gitCheckoutState,
} = {}) {
  verifyHanjiNamespace({ root });
  const configPath = resolve(backendDir, 'edgebase.config.ts');
  const source = readFileSync(configPath, 'utf8');
  const wranglerSource = readFileSync(resolve(backendDir, 'wrangler.toml'), 'utf8');
  const typescript = requireFromBackend('typescript');
  if (!releaseModeEnabled(source, typescript)) {
    throw new Error('backend/edgebase.config.ts must set top-level release: true.');
  }
  if (!secureBrowserSessionConfigured(source, typescript)) {
    throw new Error(
      'backend/edgebase.config.ts must enable the named Strict HttpOnly-cookie session transport with credentialed exact CORS origins.',
    );
  }
  if (!runtimeProcessEnvCompatibilityConfigured(wranglerSource)) {
    throw new Error(
      'backend/wrangler.toml must enable nodejs_compat and nodejs_compat_populate_process_env so release secrets reach config-time process.env.',
    );
  }

  let envFileIsRegular = false;
  try {
    envFileIsRegular = lstatSync(envFile).isFile();
  } catch {
    // The strict file validator below produces the stable actionable error.
  }
  const fileEnv = existsSync(envFile) && (!strictRelease || envFileIsRegular)
    ? parseEnvFile(readFileSync(envFile, 'utf8'))
    : {};
  const strictFileErrors = strictRelease ? strictReleaseEnvFileErrors(envFile, fileEnv) : [];
  const rawEnv = { ...fileEnv, ...runtimeEnv };
  const env = canonicalizeHanjiEnvironment(rawEnv);
  const checkoutState = strictRelease
    ? (gitCheckoutState ?? publicGitCheckoutState())
    : { head: '', status: '' };
  const shouldValidateEnvironment = requireEnv || strictRelease;
  const result = shouldValidateEnvironment
    ? validateProductionEnvironment(rawEnv, {
      requireLegalUrls: strictRelease,
      hostedEmailBindingProven: hostedEmailBindingConfigured(wranglerSource),
      expectedBuildSha: checkoutState.head,
    })
    : { errors: [], warnings: [] };
  result.errors.unshift(...strictFileErrors);
  if (strictRelease) {
    result.errors.push(...viteProductionEnvironmentErrors());
    result.errors.push(...strictGitCheckoutErrors(checkoutState));
  }
  if (strictRelease && result.errors.length === 0) {
    const origins = await verifyProductionOriginsResolve(env, { resolveHost });
    result.errors.push(...origins.errors);
  }
  if (strictRelease && result.errors.length === 0) {
    const reachability = await verifyLegalUrlsReachable(env, { fetchImpl, resolveHost });
    result.errors.push(...reachability.errors);
  }
  if (result.errors.length) {
    throw new Error(`Production environment preflight failed:\n- ${result.errors.join('\n- ')}`);
  }
  return result;
}

export function parsePreflightArgs(args) {
  const options = {
    requireEnv: false,
    strictRelease: false,
    envFile: resolve(backendDir, '.env.release'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--require-env') {
      options.requireEnv = true;
      continue;
    }
    if (arg === '--strict-release') {
      options.requireEnv = true;
      options.strictRelease = true;
      continue;
    }
    if (arg === '--env-file') {
      const path = args[index + 1];
      if (!path || path.startsWith('--')) throw new Error('--env-file requires a path.');
      options.envFile = resolve(path);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPreflight(parsePreflightArgs(process.argv.slice(2)));
    for (const warning of result.warnings) console.warn(`WARN ${warning}`);
    console.log('PASS release configuration preflight.');
  } catch (error) {
    console.error(`FAIL release configuration preflight: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
