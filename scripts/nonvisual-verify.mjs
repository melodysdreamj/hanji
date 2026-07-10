#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_APP_URL = process.env.NOTIONLIKE_EDGEBASE_APP_URL;
const DEFAULT_MOCK_NOTION_API_BASE = process.env.NOTIONLIKE_MOCK_NOTION_API_BASE ?? 'http://127.0.0.1:9797/v1';
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_NOTION_IMPORT_SECRET =
  process.env.NOTIONLIKE_NOTION_IMPORT_SECRET ??
  'notionlike-nonvisual-import-secret-use-real-secret-outside-tests';
const DEFAULT_NOTION_OAUTH_CLIENT_ID =
  process.env.NOTIONLIKE_NOTION_OAUTH_CLIENT_ID ?? 'mock-notion-oauth-client';
const DEFAULT_NOTION_OAUTH_CLIENT_SECRET =
  process.env.NOTIONLIKE_NOTION_OAUTH_CLIENT_SECRET ?? 'mock-notion-oauth-secret';
const DEFAULT_NOTION_OAUTH_STATE_SECRET =
  process.env.NOTIONLIKE_NOTION_OAUTH_STATE_SECRET ?? DEFAULT_NOTION_IMPORT_SECRET;

const options = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(options.url);
const appUrl = normalizeBaseUrl(options.appUrl ?? options.url);
const mockNotionApiBase = normalizeBaseUrl(options.mockNotionApiBase);

let devServer = null;
let devServerStartedByScript = false;
let strictNotionImportChecks = false;
const devLogs = [];

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL non-visual verification: ${message}`);
  if (devLogs.length) {
    console.error('\nLast EdgeBase dev server output:');
    console.error(devLogs.slice(-60).join('\n'));
  }
  process.exitCode = 1;
} finally {
  await stopDevServer();
}

async function main() {
  console.log(`Non-visual verification target: ${baseUrl}`);
  if (appUrl !== baseUrl) console.log(`Non-visual verification app target: ${appUrl}`);

  if (options.onlyNotionImport) {
    await ensureRuntime();
    await runNotionImportSteps();
    console.log('\nPASS focused Notion import verification completed.');
    return;
  }

  if (!options.skipBuild) {
    await runStep('web build', 'npm', ['--prefix', 'web', 'run', 'build']);
  }

  if (!options.skipLint) {
    await runStep('web lint', 'npm', ['--prefix', 'web', 'run', 'lint']);
  }

  await runStep('local EdgeBase link check', 'npm', ['--prefix', 'backend', 'run', 'verify:local-edgebase']);

  if (!options.skipBundle) {
    await runStep('EdgeBase app bundle check', 'npm', [
      '--prefix',
      'backend',
      'run',
      'verify:bundle',
      '--',
      '--skip-web-build',
    ]);
  }

  await runStep('MCP syntax check', 'npm', ['--prefix', 'mcp', 'run', 'check']);
  await runStep('MCP tool advertisement smoke', 'npm', ['--prefix', 'mcp', 'run', 'smoke']);

  await ensureRuntime();

  await runStep('SPA/runtime smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:runtime']);
  if (isLocalAppOrigin(appUrl)) {
    await runStep('development guest login smoke', 'npm', [
      '--prefix',
      'backend',
      'run',
      'verify:dev-guest-login',
      '--',
      '--url',
      appUrl,
      '--api-url',
      baseUrl,
    ]);
  } else {
    console.log('\n> development guest login smoke');
    console.log('SKIP development guest login smoke for non-local app URL.');
  }
  await runStep('auth UI smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:auth-ui',
    '--',
    '--url',
    appUrl,
    '--api-url',
    baseUrl,
  ]);
  await runStep('security settings UI smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:security-settings-ui',
    '--',
    '--url',
    appUrl,
    '--api-url',
    baseUrl,
  ]);
  await runStep('workspace invite UI smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:workspace-invite-ui',
    '--',
    '--url',
    appUrl,
    '--api-url',
    baseUrl,
  ]);
  await runStep('trash UI state smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:trash-ui']);
  await runStep('page chrome UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:page-chrome-ui']);
  await runStep('page tree UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:page-tree-ui']);
  await runStep('block editor UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:block-editor-ui']);
  await runStep('block actions UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:block-actions-ui']);
  await runStep('block drag UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:block-drag-ui']);
  await runStep('block reorder UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:block-reorder-ui']);
  await runStep('workspace membership smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:memberships']);
  await runStep('workspace switcher UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:workspace-switcher-ui']);
  await runStep('identity lookup UI smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:identity-lookup-ui',
    '--',
    '--url',
    appUrl,
    '--api-url',
    baseUrl,
  ]);
  await runStep('multi-user permission smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:permissions']);
  await runStep('page email share UI smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:page-email-share-ui',
    '--',
    '--url',
    appUrl,
    '--api-url',
    baseUrl,
  ]);
  await runStep('page presence UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:presence']);
  await runStep('search UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:search-ui']);
  await runStep('comment UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:comments-ui']);
  await runStep('collaboration smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:collaboration']);
  await runStep('database property edit UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-property-edit']);
  await runStep('database property drag UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-property-drag']);
  await runStep('database property menu UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-property-menu']);
  await runStep('database property resize UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-property-resize']);
  await runStep('database row drag UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-row-drag']);
  await runStep('database board drag UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-board-drag']);
  await runStep('database calendar drag UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-calendar-drag']);
  await runStep('database timeline drag UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-timeline-drag']);
  await runStep('database view tabs drag UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-view-tabs-drag']);
  await runStep('database row peek UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-row-peek']);
  await runStep('database views UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-views-ui']);
  await runStep('database imported view config UI smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:database-imported-view-config',
    '--',
    '--url',
    appUrl,
    '--api-url',
    baseUrl,
  ]);
  await runStep('database row lifecycle smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-row-lifecycle']);
  await runStep('database relation smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-relations']);
  await runStep('database template smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:database-templates']);
  await runStep('page template UI smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:page-templates-ui']);
  await runStep('import/export smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:import-export']);
  await runNotionImportSteps();
  await runStep('file permission smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:files']);
  await runStep('public sharing smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:sharing']);
  await runStep('notification smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:notifications']);
  await runStep('updates UI smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:updates-ui',
    '--',
    '--url',
    appUrl,
    '--api-url',
    baseUrl,
  ]);
  await runStep('MCP live smoke', 'npm', ['--prefix', 'mcp', 'run', 'smoke:live']);

  console.log('\nPASS non-visual verification suite completed.');
}

async function ensureRuntime() {
  if (await isRuntimeReachable()) {
    console.log('PASS EdgeBase runtime is already reachable; reusing it.');
    if (canAssumeMockNotionRuntime()) {
      strictNotionImportChecks = options.expectStoredNotionConnection;
      console.log(
        strictNotionImportChecks
          ? 'PASS existing runtime is configured for strict mock Notion import checks.'
          : 'PASS existing runtime is configured for mock Notion import checks.',
      );
    } else {
      console.log('SKIP strict mock Notion import checks for reused runtime; start it with NOTIONLIKE_NOTION_API_BASE to enable them.');
    }
    return;
  }

  await startDevServer();
}

async function startDevServer() {
  console.log('Starting local EdgeBase dev runtime for smoke checks...');
  devServerStartedByScript = true;
  strictNotionImportChecks = true;
  devServer = spawn('npm', ['--prefix', 'backend', 'run', 'dev'], {
    cwd: root,
    env: {
      ...process.env,
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
      ...strictNotionRuntimeEnv(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  devServer.stdout.on('data', (chunk) => captureDevOutput(chunk));
  devServer.stderr.on('data', (chunk) => captureDevOutput(chunk));

  const exited = new Promise((_, reject) => {
    devServer.once('exit', (code, signal) => {
      reject(new Error(`EdgeBase dev server exited before becoming ready (code ${code}, signal ${signal}).`));
    });
  });

  await Promise.race([waitForRuntimeReady(), exited]);
  console.log('PASS local EdgeBase dev runtime is ready.');
}

function captureDevOutput(chunk) {
  const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    devLogs.push(line);
    if (devLogs.length > 200) devLogs.shift();
  }
}

async function stopDevServer() {
  if (!devServer || !devServerStartedByScript) return;
  if (devServer.exitCode !== null || devServer.signalCode !== null) return;

  devServer.kill('SIGINT');
  const exited = new Promise((resolveExit) => {
    devServer.once('exit', resolveExit);
  });
  const timedOut = new Promise((resolveTimeout) => {
    setTimeout(resolveTimeout, 5000, 'timeout');
  });
  const result = await Promise.race([exited, timedOut]);
  if (result === 'timeout' && devServer.exitCode === null) {
    devServer.kill('SIGTERM');
  }
}

async function waitForRuntimeReady() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.readyTimeoutMs) {
    if (await isRuntimeReachable()) return;
    await delay(500);
  }
  throw new Error(`EdgeBase runtime did not become ready within ${options.readyTimeoutMs}ms.`);
}

async function isRuntimeReachable() {
  try {
    const response = await fetch(resolveUrl(baseUrl, '/api/health'), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function runNotionImportSteps() {
  if (strictNotionImportChecks || canAssumeMockNotionRuntime()) {
    const args = [
      '--prefix',
      'backend',
      'run',
      'verify:notion-import',
      '--',
      '--mock-notion-api-base',
      mockNotionApiBase,
    ];
    if (strictNotionImportChecks) args.push('--expect-stored-connection');
    await runStep('Notion import job smoke', 'npm', args);

    const uiArgs = [
      '--prefix',
      'backend',
      'run',
      'verify:notion-import-ui',
      '--',
      '--url',
      appUrl,
      '--api-url',
      baseUrl,
      '--mock-notion-api-base',
      mockNotionApiBase,
    ];
    if (strictNotionImportChecks) uiArgs.push('--expect-stored-connection');
    await runStep('Notion import UI smoke', 'npm', uiArgs);
    await runLiveNotionImportSmoke();
    return;
  }

  await runStep('Notion import job smoke', 'npm', ['--prefix', 'backend', 'run', 'verify:notion-import']);
  await runStep('Notion import UI smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:notion-import-ui',
    '--',
    '--url',
    appUrl,
    '--api-url',
    baseUrl,
    '--mock-notion-api-base',
    mockNotionApiBase,
  ]);
  await runLiveNotionImportSmoke();
}

async function runLiveNotionImportSmoke() {
  await runStep('optional live Notion import review smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:notion-import-live',
    '--',
    '--url',
    baseUrl,
    '--allow-empty',
    '--timeout-ms',
    '120000',
  ]);

  if (!hasLiveNotionToken()) {
    console.log('\n> optional live Notion template import/apply/share smoke');
    console.log('SKIP live Notion template smoke because NOTION_TOKEN or NOTIONLIKE_NOTION_TOKEN is not configured.');
    return;
  }
  if (strictNotionImportChecks || canAssumeMockNotionRuntime()) {
    console.log('\n> optional live Notion template import/apply/share smoke');
    console.log('SKIP live Notion template smoke while the runtime is configured for the mock Notion API.');
    return;
  }

  await runStep('optional live Notion template import/apply/share smoke', 'npm', [
    '--prefix',
    'backend',
    'run',
    'verify:notion-import-live-template',
    '--',
    '--url',
    baseUrl,
  ]);
}

function hasLiveNotionToken() {
  return Boolean(process.env.NOTION_TOKEN?.trim() || process.env.NOTIONLIKE_NOTION_TOKEN?.trim());
}

function canAssumeMockNotionRuntime() {
  return normalizeMaybeUrl(process.env.NOTIONLIKE_NOTION_API_BASE) === mockNotionApiBase;
}

function strictNotionRuntimeEnv() {
  return {
    NOTIONLIKE_NOTION_API_BASE: mockNotionApiBase,
    NOTIONLIKE_MOCK_NOTION_API_BASE: mockNotionApiBase,
    NOTIONLIKE_NOTION_IMPORT_SECRET: DEFAULT_NOTION_IMPORT_SECRET,
    NOTIONLIKE_NOTION_OAUTH_CLIENT_ID: DEFAULT_NOTION_OAUTH_CLIENT_ID,
    NOTIONLIKE_NOTION_OAUTH_CLIENT_SECRET: DEFAULT_NOTION_OAUTH_CLIENT_SECRET,
    NOTIONLIKE_NOTION_OAUTH_STATE_SECRET: DEFAULT_NOTION_OAUTH_STATE_SECRET,
    NOTIONLIKE_EXPECT_STORED_NOTION_CONNECTION: '1',
  };
}

async function runStep(label, command, args) {
  console.log(`\n> ${label}`);
  await new Promise((resolveStep, rejectStep) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        VITE_ALLOW_ANONYMOUS_BOOTSTRAP: process.env.VITE_ALLOW_ANONYMOUS_BOOTSTRAP ?? 'true',
        NOTIONLIKE_ALLOW_DEV_GUEST_LOGIN: process.env.NOTIONLIKE_ALLOW_DEV_GUEST_LOGIN ?? 'true',
        NOTIONLIKE_EDGEBASE_URL: baseUrl,
        NOTIONLIKE_EDGEBASE_API_URL: baseUrl,
        NOTIONLIKE_EDGEBASE_APP_URL: appUrl,
        ...(strictNotionImportChecks ? strictNotionRuntimeEnv() : {}),
      },
      stdio: 'inherit',
    });
    child.once('error', rejectStep);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveStep();
        return;
      }
      rejectStep(new Error(`${label} failed (code ${code}, signal ${signal}).`));
    });
  });
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    appUrl: DEFAULT_APP_URL,
    mockNotionApiBase: DEFAULT_MOCK_NOTION_API_BASE,
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    expectStoredNotionConnection: process.env.NOTIONLIKE_EXPECT_STORED_NOTION_CONNECTION === '1',
    onlyNotionImport: false,
    skipBuild: false,
    skipLint: false,
    skipBundle: false,
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
    if (arg === '--app-url') {
      parsed.appUrl = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--ready-timeout-ms') {
      parsed.readyTimeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.readyTimeoutMs) || parsed.readyTimeoutMs <= 0) {
        throw new Error('--ready-timeout-ms must be a positive number');
      }
      i += 1;
      continue;
    }
    if (arg === '--mock-notion-api-base') {
      parsed.mockNotionApiBase = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--expect-stored-notion-connection') {
      parsed.expectStoredNotionConnection = true;
      continue;
    }
    if (arg === '--only-notion-import') {
      parsed.onlyNotionImport = true;
      continue;
    }
    if (arg === '--skip-build') {
      parsed.skipBuild = true;
      continue;
    }
    if (arg === '--skip-lint') {
      parsed.skipLint = true;
      continue;
    }
    if (arg === '--skip-bundle') {
      parsed.skipBundle = true;
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
  console.log(`Usage: node scripts/nonvisual-verify.mjs [options]

Runs the non-visual Notionlike verification suite:
- web build/typecheck
- web lint
- local EdgeBase link check
- EdgeBase app bundle check
- MCP syntax and tool advertisement smoke
- local EdgeBase dev runtime startup when needed
- runtime, local development guest login, trash empty state, identity lookup UI, permissions, collaboration, files, public sharing, notifications, Updates UI, Notion import API/UI, imported database view UI, and MCP live smokes
- strict mock Notion stored-connection/OAuth checks when this script starts the runtime
- optional live Notion API discovery/review smoke when NOTION_TOKEN or NOTIONLIKE_NOTION_TOKEN is configured
- optional live EXAM PLANNER template import/apply/public-share smoke when a live token is configured and the runtime is not using the mock Notion API

Options:
  --url <url>                    Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or http://127.0.0.1:8787.
  --app-url <url>                App URL for browser UI checks. Defaults to NOTIONLIKE_EDGEBASE_APP_URL or --url.
  --ready-timeout-ms <number>    Dev runtime startup timeout. Defaults to ${DEFAULT_READY_TIMEOUT_MS}.
  --mock-notion-api-base <url>   Mock Notion API base for strict import checks. Defaults to ${DEFAULT_MOCK_NOTION_API_BASE}.
  --expect-stored-notion-connection
                                  Require stored Notion connection checks when reusing an already-running mock-configured runtime.
  --only-notion-import           Run only the Notion import API/UI portion of the suite.
  --skip-build                   Skip npm --prefix web run build.
  --skip-lint                    Skip npm --prefix web run lint.
  --skip-bundle                  Skip backend verify:bundle.
`);
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeMaybeUrl(value) {
  if (!value) return '';
  try {
    return normalizeBaseUrl(value);
  } catch {
    return '';
  }
}

function isLocalAppOrigin(value) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function resolveUrl(baseUrlValue, path) {
  return new URL(path, `${baseUrlValue}/`).toString();
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
