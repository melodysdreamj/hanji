#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_API_URL = process.env.HANJI_EDGEBASE_API_URL ?? DEFAULT_BASE_URL;
const DEFAULT_MOCK_NOTION_API_BASE =
  process.env.HANJI_MOCK_NOTION_API_BASE ?? 'http://127.0.0.1:9797/v1';
const DEFAULT_NOTION_IMPORT_SECRET =
  process.env.HANJI_NOTION_IMPORT_SECRET ??
  'hanji-ui-import-secret-use-real-secret-outside-tests';
const DEFAULT_NOTION_OAUTH_CLIENT_ID =
  process.env.HANJI_NOTION_OAUTH_CLIENT_ID ?? 'mock-notion-oauth-client';
const DEFAULT_NOTION_OAUTH_CLIENT_SECRET =
  process.env.HANJI_NOTION_OAUTH_CLIENT_SECRET ?? 'mock-notion-oauth-secret';
const DEFAULT_NOTION_OAUTH_STATE_SECRET =
  process.env.HANJI_NOTION_OAUTH_STATE_SECRET ?? DEFAULT_NOTION_IMPORT_SECRET;
const NOTION_UI_RUNTIME_ENV_KEYS = [
  'HANJI_ALLOW_DEV_GUEST_LOGIN',
  'HANJI_NOTION_API_BASE',
  'HANJI_NOTION_IMPORT_SECRET',
  'HANJI_NOTION_OAUTH_ENABLED',
  'HANJI_NOTION_OAUTH_CLIENT_ID',
  'HANJI_NOTION_OAUTH_CLIENT_SECRET',
  'HANJI_NOTION_OAUTH_STATE_SECRET',
];

const options = parseArgs(process.argv.slice(2));
const apiUrl = normalizeBaseUrl(options.apiUrl);
const mockNotionApiBase = normalizeBaseUrl(options.mockNotionApiBase);

try {
  await main();
} catch (error) {
  console.error(
    `\nFAIL managed Notion import UI smoke: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}

async function main() {
  if (!options.skipRuntimeRefresh) {
    await refreshRuntime('mock Notion API', strictNotionRuntimeEnv(), ['--skip-verify']);
  }

  try {
    await run('Notion import UI smoke', 'node', ['scripts/notion-import-ui-smoke.mjs', ...options.forwardedArgs], {
      ...process.env,
      ...strictNotionRuntimeEnv(),
    });
  } finally {
    if (!options.keepMockRuntime && !options.skipRuntimeRefresh) {
      await refreshRuntime('normal local runtime', process.env, []);
    }
  }
}

async function refreshRuntime(label, env, extraArgs) {
  console.log(`\n> Refresh EdgeBase dev runtime for ${label}`);
  await run(
    `refresh EdgeBase dev runtime for ${label}`,
    'node',
    ['scripts/refresh-edgebase-dev.mjs', '--url', apiUrl, ...extraArgs],
    env,
  );
}

async function run(label, command, args, env) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${label} failed (code ${code}, signal ${signal}).`));
    });
  });
}

function strictNotionRuntimeEnv() {
  return {
    ...process.env,
    // EdgeBase intentionally isolates the ambient shell from config evaluation
    // and Worker bindings. The default backend dev command now honors an
    // explicit inherited allowlist, so this managed smoke names only the test
    // values its mock Notion runtime needs.
    EDGEBASE_CONFIG_ENV_ALLOWLIST: Array.from(new Set([
      ...(process.env.EDGEBASE_CONFIG_ENV_ALLOWLIST ?? '').split(',').map((key) => key.trim()).filter(Boolean),
      ...NOTION_UI_RUNTIME_ENV_KEYS,
    ])).join(','),
    HANJI_EDGEBASE_URL: apiUrl,
    HANJI_EDGEBASE_API_URL: apiUrl,
    HANJI_NOTION_API_BASE: mockNotionApiBase,
    HANJI_MOCK_NOTION_API_BASE: mockNotionApiBase,
    HANJI_NOTION_IMPORT_SECRET: DEFAULT_NOTION_IMPORT_SECRET,
    HANJI_NOTION_OAUTH_ENABLED: 'true',
    HANJI_NOTION_OAUTH_CLIENT_ID: DEFAULT_NOTION_OAUTH_CLIENT_ID,
    HANJI_NOTION_OAUTH_CLIENT_SECRET: DEFAULT_NOTION_OAUTH_CLIENT_SECRET,
    HANJI_NOTION_OAUTH_STATE_SECRET: DEFAULT_NOTION_OAUTH_STATE_SECRET,
    HANJI_EXPECT_STORED_NOTION_CONNECTION: '1',
  };
}

function parseArgs(args) {
  const parsed = {
    apiUrl: DEFAULT_API_URL,
    forwardedArgs: [...args],
    keepMockRuntime: false,
    mockNotionApiBase: DEFAULT_MOCK_NOTION_API_BASE,
    skipRuntimeRefresh: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--api-url') {
      parsed.apiUrl = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--url' && !args.includes('--api-url')) {
      parsed.apiUrl = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--mock-notion-api-base') {
      parsed.mockNotionApiBase = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--keep-mock-runtime') {
      parsed.keepMockRuntime = true;
      parsed.forwardedArgs = parsed.forwardedArgs.filter((item) => item !== '--keep-mock-runtime');
      continue;
    }
    if (arg === '--skip-runtime-refresh') {
      parsed.skipRuntimeRefresh = true;
      parsed.forwardedArgs = parsed.forwardedArgs.filter((item) => item !== '--skip-runtime-refresh');
      continue;
    }
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${label} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/notion-import-ui-runtime-smoke.mjs [options]

Refreshes the local EdgeBase dev runtime with HANJI_NOTION_API_BASE pointed
at the mock Notion API, runs the Notion import UI smoke, then restores the
normal local runtime.

All regular scripts/notion-import-ui-smoke.mjs options are forwarded.

Options:
  --url <url>                     App URL forwarded to the UI smoke.
  --api-url <url>                 EdgeBase API/runtime URL. Defaults to ${DEFAULT_API_URL}.
  --mock-notion-api-base <url>    Mock Notion API base. Defaults to ${DEFAULT_MOCK_NOTION_API_BASE}.
  --keep-mock-runtime             Leave the runtime configured for the mock Notion API.
  --skip-runtime-refresh          Run the UI smoke without refreshing/restoring the runtime.
`);
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}
