#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotateFile } from './lib/log-rotation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'backend');
const webDir = join(root, 'web');
const webDistIndex = join(webDir, 'dist', 'index.html');
const logDir = join(root, '.edgebase', 'dev');
const logPath = join(logDir, 'edgebase-dev-refresh.log');
const MAX_RUNTIME_LOG_BYTES = 5 * 1024 * 1024;
const MAX_RUNTIME_LOG_BACKUPS = 3;
const defaultBaseUrl = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const screenSessionName = process.env.HANJI_EDGEBASE_DEV_SCREEN ?? 'hanji-edgebase-dev';
const webBuildInputs = [
  join(webDir, 'src'),
  join(webDir, 'index.html'),
  join(webDir, 'package.json'),
  join(webDir, 'package-lock.json'),
  join(webDir, 'tsconfig.json'),
  join(webDir, 'tsconfig.app.json'),
  join(webDir, 'tsconfig.node.json'),
  join(webDir, 'vite.config.ts'),
  join(webDir, 'vite.config.js'),
];

const options = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(options.url ?? defaultBaseUrl);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL EdgeBase dev runtime refresh: ${message}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`Refreshing local EdgeBase dev runtime at ${baseUrl}`);

  await ensureLocalEdgeBaseLinks();
  await ensureFreshWebDist();

  if (!options.keepExisting) {
    await stopScreenSession();
    await stopProjectRuntimeProcesses();
    await stopPortRuntimeIfOwned();
    await waitForPortToClose();
  }

  await startDetachedRuntime();
  await waitForRuntimeReady();

  if (!options.skipVerify) {
    await runCommand('npm', ['--prefix', 'backend', 'run', 'verify:runtime']);
  }

  console.log(`\nPASS EdgeBase dev runtime is refreshed and serving the latest local bundle.`);
  console.log(`Log: ${logPath}`);
}

async function ensureLocalEdgeBaseLinks() {
  await runCommand('node', ['scripts/link-local-edgebase.mjs']);
}

async function ensureFreshWebDist() {
  if (options.buildWeb === 'skip') {
    console.log('SKIP web/dist freshness build check (--skip-build-web).');
    return;
  }

  const reason =
    options.buildWeb === 'force'
      ? 'requested with --build-web'
      : staleWebDistReason();
  if (!reason) {
    console.log('PASS web/dist is newer than tracked frontend source inputs.');
    return;
  }

  console.log(`Building web/dist before refresh (${reason}).`);
  await runCommand('npm', ['--prefix', 'backend', 'run', 'build:web']);
}

function staleWebDistReason() {
  if (!existsSync(webDistIndex)) return 'web/dist/index.html is missing';

  const distMtime = statSync(webDistIndex).mtimeMs;
  const newestInput = newestMtime(webBuildInputs);
  if (!newestInput) return '';
  if (newestInput.mtimeMs > distMtime + 1000) {
    return `${relativePath(newestInput.path)} is newer than web/dist/index.html`;
  }
  return '';
}

function newestMtime(paths) {
  let newest = null;
  for (const path of paths) {
    const item = newestMtimeForPath(path);
    if (!item) continue;
    if (!newest || item.mtimeMs > newest.mtimeMs) newest = item;
  }
  return newest;
}

function newestMtimeForPath(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    let newest = { path, mtimeMs: stat.mtimeMs };
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '.vite') {
        continue;
      }
      const child = newestMtimeForPath(join(path, entry.name));
      if (child && child.mtimeMs > newest.mtimeMs) newest = child;
    }
    return newest;
  }
  return { path, mtimeMs: stat.mtimeMs };
}

async function stopScreenSession() {
  const result = await runCommand('screen', ['-S', screenSessionName, '-X', 'quit'], {
    allowFailure: true,
    quiet: true,
  });
  if (result.code === 0) {
    console.log(`Stopped screen session ${screenSessionName}.`);
  }
}

async function stopProjectRuntimeProcesses() {
  const processes = await listProcesses();
  const pids = processes
    .filter((entry) => isProjectRuntimeCommand(entry.command))
    .map((entry) => entry.pid);
  await killPids(pids, 'project EdgeBase dev runtime');
}

async function stopPortRuntimeIfOwned() {
  const pids = await pidsListeningOnPort(baseUrl);
  if (pids.length === 0) return;

  const ownsPort = await isHanjiRuntimeReachable();
  if (!ownsPort) {
    throw new Error(
      `${baseUrl} is still in use, but it does not look like this Hanji EdgeBase runtime. Stop that process manually or pass --url for another runtime.`,
    );
  }

  await killPids(pids, `Hanji runtime listening on ${baseUrl}`);
}

async function startDetachedRuntime() {
  mkdirSync(logDir, { recursive: true });
  const rotated = rotateFile(logPath, {
    maxBytes: MAX_RUNTIME_LOG_BYTES,
    maxBackups: MAX_RUNTIME_LOG_BACKUPS,
  });
  if (rotated) {
    console.log(`Rotated runtime log after ${MAX_RUNTIME_LOG_BYTES} bytes (kept ${MAX_RUNTIME_LOG_BACKUPS} backups).`);
  }
  const out = openSync(logPath, 'a');
  writeSync(out, `\n\n--- refresh ${new Date().toISOString()} ---\n`);

  const child = spawn('npm', ['--prefix', 'backend', 'run', 'dev'], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      HANJI_ALLOW_DEV_GUEST_LOGIN: process.env.HANJI_ALLOW_DEV_GUEST_LOGIN ?? 'true',
      // Request logs are high-volume during the visual suite and previously
      // grew this detached log past 100 MiB. Keep warnings/errors here; a
      // caller can opt back into verbose Wrangler output explicitly.
      WRANGLER_LOG: process.env.WRANGLER_LOG ?? 'warn',
      WRANGLER_WRITE_LOGS: process.env.WRANGLER_WRITE_LOGS ?? 'false',
    },
    stdio: ['ignore', out, out],
  });

  child.unref();
  closeSync(out);
  console.log(`Started detached EdgeBase dev runtime (pid ${child.pid}).`);
}

async function waitForRuntimeReady() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    if (await isHanjiRuntimeReachable()) {
      console.log('PASS EdgeBase dev runtime is reachable.');
      return;
    }
    await delay(500);
  }
  throw new Error(`Runtime did not become ready within ${options.timeoutMs}ms. See ${logPath}.`);
}

async function waitForPortToClose() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if ((await pidsListeningOnPort(baseUrl)).length === 0) return;
    await delay(250);
  }

  const pids = await pidsListeningOnPort(baseUrl);
  if (pids.length > 0) {
    await killPids(pids, `remaining runtime listening on ${baseUrl}`, 'SIGKILL');
  }
}

async function isHanjiRuntimeReachable() {
  try {
    const response = await fetch(resolveUrl(baseUrl, '/api/functions/health'), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && (body?.service === 'hanji-edgebase' || body?.app === 'hanji');
  } catch {
    return false;
  }
}

async function listProcesses() {
  const result = await runCommand('ps', ['-axo', 'pid=,command='], { capture: true, quiet: true });
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), command: match[2] };
    })
    .filter(Boolean);
}

function isProjectRuntimeCommand(command) {
  if (!command.includes(backendDir)) return false;
  return (
    command.includes('edgebase dev') ||
    command.includes('/wrangler/bin/wrangler.js dev') ||
    command.includes('/wrangler-dist/cli.js dev') ||
    command.includes('/workerd ') ||
    command.includes('esbuild --service=')
  );
}

async function pidsListeningOnPort(url) {
  const port = new URL(url).port;
  if (!port) return [];
  const result = await runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    allowFailure: true,
    capture: true,
    quiet: true,
  });
  if (result.code !== 0) return [];
  return Array.from(
    new Set(
      result.stdout
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  );
}

async function killPids(pids, label, signal = 'SIGTERM') {
  const uniquePids = Array.from(new Set(pids)).filter((pid) => pid > 0 && pid !== process.pid);
  if (uniquePids.length === 0) return;

  console.log(`Stopping ${label}: ${uniquePids.join(', ')}`);
  for (const pid of uniquePids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  await delay(signal === 'SIGKILL' ? 250 : 1000);
}

async function runCommand(command, args, options = {}) {
  const {
    allowFailure = false,
    capture = false,
    quiet = false,
  } = options;

  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: capture || quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (!quiet && !capture) process.stdout.write(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (!quiet && !capture) process.stderr.write(chunk);
      });
    }

    child.once('error', (error) => {
      if (allowFailure) resolveCommand({ code: 1, stdout, stderr, error });
      else rejectCommand(error);
    });
    child.once('exit', (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      if (exitCode !== 0 && !allowFailure) {
        rejectCommand(
          new Error(`${command} ${args.join(' ')} failed with code ${exitCode}${stderr ? `\n${stderr}` : ''}`),
        );
        return;
      }
      resolveCommand({ code: exitCode, stdout, stderr });
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function resolveUrl(base, pathname) {
  return new URL(pathname, `${base.replace(/\/+$/, '')}/`).toString();
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function relativePath(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function parseArgs(args) {
  const parsed = {
    buildWeb: process.env.HANJI_DEV_REFRESH_BUILD === '0' ? 'skip' : 'auto',
    url: undefined,
    keepExisting: false,
    skipVerify: false,
    timeoutMs: 60_000,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--url') {
      parsed.url = valueAfter(args, i, arg);
      i += 1;
    } else if (arg === '--build-web') {
      parsed.buildWeb = 'force';
    } else if (arg === '--skip-build-web') {
      parsed.buildWeb = 'skip';
    } else if (arg === '--keep-existing') {
      parsed.keepExisting = true;
    } else if (arg === '--skip-verify') {
      parsed.skipVerify = true;
    } else if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(valueAfter(args, i, arg));
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${parsed.timeoutMs}`);
  }
  return parsed;
}

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelpAndExit() {
  console.log(`Refresh the local Hanji EdgeBase dev runtime.

Usage:
  npm --prefix backend run dev:refresh

Options:
  --url <url>          Runtime URL. Defaults to HANJI_EDGEBASE_URL or ${defaultBaseUrl}.
  --build-web          Always rebuild web/dist before restarting the runtime.
  --skip-build-web     Do not auto-build web/dist even if frontend sources are newer.
  --keep-existing     Do not stop existing project runtime processes first.
  --skip-verify       Skip npm --prefix backend run verify:runtime after startup.
  --timeout-ms <ms>   Startup timeout. Defaults to 60000.

Environment:
  HANJI_DEV_REFRESH_BUILD=0 disables the default frontend source freshness build check.
`);
  process.exit(0);
}
