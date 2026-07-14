#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'docker-compose.synology-sim.yml');
const proxyName = 'hanji_synology_sim';
const publicPort = readPort('HANJI_SIM_PORT', 18787);
const adminPort = readPort('HANJI_SIM_ADMIN_PORT', 18474);
const baseUrl = `http://127.0.0.1:${publicPort}`;
const adminUrl = `http://127.0.0.1:${adminPort}`;

const profiles = {
  fast: [],
  nas: [
    latencyToxic('uplink_latency', 'upstream', 180, 80),
    latencyToxic('downlink_latency', 'downstream', 320, 120),
    bandwidthToxic('downlink_bandwidth', 'downstream', 4096),
  ],
  'nas-slow': [
    latencyToxic('uplink_latency', 'upstream', 450, 200),
    latencyToxic('downlink_latency', 'downstream', 650, 250),
    bandwidthToxic('uplink_bandwidth', 'upstream', 512),
    bandwidthToxic('downlink_bandwidth', 'downstream', 1024),
  ],
};

const [command = 'help', argument] = process.argv.slice(2);

try {
  if (command === 'up') {
    const profile = argument ?? 'nas';
    assertProfile(profile);
    ensureImage();
    compose(['up', '-d']);
    await waitForAdmin();
    await applyProfile(profile);
    await waitForRuntime();
    printReady(profile);
  } else if (command === 'profile') {
    const profile = argument ?? 'nas';
    if (profile === 'offline') {
      await waitForAdmin();
      await configureProxy();
      await updateProxy(false);
      console.log(`Synology simulation is offline at ${baseUrl}.`);
    } else {
      assertProfile(profile);
      await waitForAdmin();
      await applyProfile(profile);
      await waitForRuntime();
      printReady(profile);
    }
  } else if (command === 'cut') {
    const seconds = parseCutSeconds(argument);
    await waitForAdmin();
    await updateProxy(false);
    console.log(`Dropped active HTTP/WebSocket connections for ${seconds}s.`);
    await delay(seconds * 1000);
    await updateProxy(true);
    await waitForRuntime();
    console.log(`Connection restored at ${baseUrl}.`);
  } else if (command === 'status') {
    compose(['ps']);
    const proxy = await getJson(`/proxies/${proxyName}`).catch(() => null);
    if (!proxy) {
      console.log('Toxiproxy is not configured. Run: npm run sim:synology -- up');
    } else {
      console.log(JSON.stringify({
        url: baseUrl,
        enabled: proxy.enabled,
        toxics: proxy.toxics.map(({ name, type, stream, attributes }) => ({
          name,
          type,
          stream,
          attributes,
        })),
      }, null, 2));
    }
  } else if (command === 'logs') {
    compose(['logs', '--tail', '200', '-f'], { stdio: 'inherit' });
  } else if (command === 'down') {
    compose(['down']);
    console.log('Simulation stopped. The Docker data volume was preserved.');
  } else if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`synology-sim: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function readPort(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return value;
}

function parseCutSeconds(value) {
  const seconds = Number(value ?? 3);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
    throw new Error('cut duration must be greater than 0 and at most 30 seconds');
  }
  return seconds;
}

function latencyToxic(name, stream, latency, jitter) {
  return {
    name,
    type: 'latency',
    stream,
    toxicity: 1,
    attributes: { latency, jitter },
  };
}

function bandwidthToxic(name, stream, rate) {
  return {
    name,
    type: 'bandwidth',
    stream,
    toxicity: 1,
    attributes: { rate },
  };
}

function assertProfile(profile) {
  if (!Object.hasOwn(profiles, profile)) {
    throw new Error(`Unknown profile '${profile}'. Use fast, nas, nas-slow, or offline.`);
  }
}

function ensureImage() {
  const image = process.env.HANJI_SIM_IMAGE ?? 'hanji:synology-sim';
  const result = spawnSync('docker', ['image', 'inspect', image], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'ignore',
  });
  if (result.status !== 0) {
    throw new Error(
      `Docker image '${image}' is missing. Build the current source first with ` +
      '`npm run sim:synology:build`, or set HANJI_SIM_IMAGE to an existing image.',
    );
  }
}

function compose(args, options = {}) {
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: root,
    encoding: options.stdio === 'inherit' ? undefined : 'utf8',
    stdio: options.stdio ?? 'pipe',
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`docker compose ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
}

async function waitForAdmin() {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${adminUrl}/version`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Toxiproxy did not become ready: ${lastError?.message ?? 'unknown error'}`);
}

async function waitForRuntime() {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(750);
  }
  throw new Error(`Hanji did not become reachable through the impaired path: ${lastError?.message ?? 'unknown error'}`);
}

async function applyProfile(profile) {
  await configureProxy();
  await postJson('/reset', {});
  await updateProxy(true);
  for (const toxic of profiles[profile]) {
    await postJson(`/proxies/${proxyName}/toxics`, toxic);
  }
}

async function configureProxy() {
  await postJson('/populate', [{
    name: proxyName,
    listen: '0.0.0.0:8787',
    upstream: 'hanji:8787',
    enabled: true,
  }]);
}

async function updateProxy(enabled) {
  return requestJson('PATCH', `/proxies/${proxyName}`, { enabled });
}

async function getJson(path) {
  const response = await fetch(`${adminUrl}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(3000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function postJson(path, body) {
  return requestJson('POST', path, body);
}

async function requestJson(method, path, body) {
  const response = await fetch(`${adminUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function printReady(profile) {
  const description = profile === 'fast'
    ? 'no injected network latency'
    : profile === 'nas'
      ? 'about 500ms RTT with jitter and a 4MiB/s download cap'
      : 'about 1.1s RTT with jitter and constrained bandwidth';
  console.log(`Synology simulation ready: ${baseUrl}`);
  console.log(`Profile '${profile}': ${description}.`);
  console.log('Hanji container limits default to 1 CPU, 1536MiB memory, and 256 processes.');
}

function printHelp() {
  console.log(`Usage: npm run sim:synology -- <command> [argument]

Commands:
  up [fast|nas|nas-slow]       Start the stack and apply a latency profile
  profile <name|offline>       Change the live profile without losing data
  cut [seconds]                Drop active HTTP/WebSocket connections, then restore
  status                       Show containers and active network toxics
  logs                         Follow Hanji and proxy logs
  down                         Stop containers while preserving the data volume

Environment:
  HANJI_SIM_IMAGE              Image to run (default: hanji:synology-sim)
  HANJI_SIM_PORT               Browser port (default: 18787)
  HANJI_SIM_ADMIN_PORT         Loopback-only proxy admin port (default: 18474)
  HANJI_SIM_CPUS               CPU limit (default: 1.0)
  HANJI_SIM_MEMORY             Memory limit (default: 1536m)
  HANJI_SIM_PIDS               Process limit (default: 256)
`);
}
