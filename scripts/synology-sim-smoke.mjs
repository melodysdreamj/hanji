#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  assertRuntimeReachable,
  callFunction,
  fetchWithTimeout,
  finalizeRegisteredSmokeAccounts,
  normalizeBaseUrl,
  permanentlyDeletePage,
  readJson,
  resolveUrl,
  signIn,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'docker-compose.synology-sim.yml');
const options = parseArgs(process.argv.slice(2));

let failure;
let report;
let adminToken = '';
const createdPageIds = [];
try {
  await assertRuntimeReachable(options.url, { timeoutMs: 10_000 });
  const proxy = await readAdminJson(`/proxies/${options.proxyName}`);
  assert(proxy.enabled === true, 'simulation proxy must be enabled');

  const upstreamLatency = proxy.toxics.find(
    (toxic) => toxic.type === 'latency' && toxic.stream === 'upstream',
  );
  const downstreamLatency = proxy.toxics.find(
    (toxic) => toxic.type === 'latency' && toxic.stream === 'downstream',
  );
  assert(upstreamLatency, 'simulation must inject upstream latency');
  assert(downstreamLatency, 'simulation must inject downstream latency');

  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    const startedAt = performance.now();
    const response = await fetchWithTimeout(resolveUrl(options.url, '/api/health'), {
      headers: { Accept: 'application/json', Connection: 'close' },
    }, { timeoutMs: 10_000 });
    assert(response.ok, `/api/health sample ${index + 1} returned HTTP ${response.status}`);
    await response.arrayBuffer();
    samples.push(Math.round(performance.now() - startedAt));
  }
  const medianMs = [...samples].sort((a, b) => a - b)[1];
  assert(
    medianMs >= options.minLatencyMs,
    `median health latency ${medianMs}ms did not prove the ${options.minLatencyMs}ms impairment floor`,
  );

  const containerId = execFileSync(
    'docker',
    ['compose', '-f', composeFile, 'ps', '-q', 'hanji'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  assert(containerId, 'synology simulation Hanji container must be running');
  const inspect = JSON.parse(execFileSync(
    'docker',
    ['inspect', containerId],
    { cwd: root, encoding: 'utf8' },
  ))[0];
  assert(inspect?.HostConfig?.NanoCpus > 0, 'simulation must set a CPU limit');
  assert(inspect?.HostConfig?.Memory > 0, 'simulation must set a memory limit');
  assert(inspect?.HostConfig?.PidsLimit > 0, 'simulation must set a process limit');
  assert(inspect?.RestartCount === 0, `stable simulation must start without a restart, got ${inspect?.RestartCount}`);

  adminToken = await signInSimulationAdmin();
  assert(adminToken, 'master session must be created through the impaired path');
  const product = await verifyDatabaseRelationRollup();

  await setProxyEnabled(false);
  let rejectedWhileOffline = false;
  try {
    await fetchWithTimeout(resolveUrl(options.url, '/api/health'), {}, { timeoutMs: 1500 });
  } catch {
    rejectedWhileOffline = true;
  } finally {
    await setProxyEnabled(true);
  }
  assert(rejectedWhileOffline, 'disabled proxy must reject the browser path');
  await assertRuntimeReachable(options.url, { timeoutMs: 10_000 });
  const finalInspect = JSON.parse(execFileSync(
    'docker',
    ['inspect', containerId],
    { cwd: root, encoding: 'utf8' },
  ))[0];
  assert(finalInspect?.RestartCount === 0, `simulation restarted during the smoke, got ${finalInspect?.RestartCount}`);
  assert(finalInspect?.State?.OOMKilled === false, 'simulation must not be OOM-killed under the stable default profile');

  report = {
    status: 'PASS',
    url: options.url,
    healthLatencyMs: samples,
    limits: {
      cpus: inspect.HostConfig.NanoCpus / 1_000_000_000,
      memoryMiB: Math.round(inspect.HostConfig.Memory / 1024 / 1024),
      pids: inspect.HostConfig.PidsLimit,
      restarts: finalInspect.RestartCount,
    },
    disconnectRecovery: true,
    product,
  };
} catch (error) {
  failure = error;
} finally {
  try {
    await setProxyEnabled(true);
    for (const pageId of [...createdPageIds].reverse()) {
      await permanentlyDeletePage(options.url, adminToken, pageId, {
        call: callFunction,
        timeoutMs: 20_000,
      });
    }
  } catch (cleanupError) {
    if (!failure) failure = cleanupError;
    else console.error(`synology simulation cleanup warning: ${cleanupError.message}`);
  }
  await finalizeRegisteredSmokeAccounts('Synology simulation smoke');
}

if (failure) throw failure;
console.log(JSON.stringify(report, null, 2));

function parseArgs(args) {
  const parsed = {
    adminUrl: `http://127.0.0.1:${process.env.HANJI_SIM_ADMIN_PORT ?? 18474}`,
    minLatencyMs: 250,
    proxyName: 'hanji_synology_sim',
    url: `http://127.0.0.1:${process.env.HANJI_SIM_PORT ?? 18787}`,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--url') parsed.url = args[++index] ?? parsed.url;
    else if (arg === '--admin-url') parsed.adminUrl = args[++index] ?? parsed.adminUrl;
    else if (arg === '--min-latency-ms') parsed.minLatencyMs = Number(args[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  parsed.url = normalizeBaseUrl(parsed.url);
  parsed.adminUrl = normalizeBaseUrl(parsed.adminUrl);
  assert(Number.isFinite(parsed.minLatencyMs) && parsed.minLatencyMs >= 0, '--min-latency-ms must be non-negative');
  return parsed;
}

async function readAdminJson(path) {
  const response = await fetchWithTimeout(resolveUrl(options.adminUrl, path), {
    headers: { Accept: 'application/json' },
  }, { timeoutMs: 5000 });
  const body = await readJson(response);
  assert(response.ok, `${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function signInSimulationAdmin() {
  const session = await signIn(options.url, {
    mode: 'master',
    timeoutMs: 15_000,
    credentials: {
      email: process.env.HANJI_SIM_MASTER_EMAIL ?? 'master@hanji.local',
      password: process.env.HANJI_SIM_MASTER_PASSWORD ?? 'HanjiMaster!2026',
    },
  });
  return session.accessToken;
}

async function verifyDatabaseRelationRollup() {
  const timings = [];
  const bootstrap = await timed('workspace-bootstrap', () =>
    callFunction(options.url, adminToken, 'workspace-bootstrap', {}, { timeoutMs: 20_000 }));
  const workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');

  const suffix = Date.now();
  const projectDbId = crypto.randomUUID();
  const taskDbId = crypto.randomUUID();

  const projectDatabase = await timed('create-project-database', () => callFunction(options.url, adminToken, 'database-mutation', {
    action: 'createDatabase',
    id: projectDbId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `NAS simulation projects ${suffix}`,
    position: suffix,
    seedRows: false,
  }, { timeoutMs: 20_000 }));
  assert(projectDatabase?.page?.id === projectDbId, 'project database must be created');
  createdPageIds.push(projectDbId);
  const taskDatabase = await timed('create-task-database', () => callFunction(options.url, adminToken, 'database-mutation', {
    action: 'createDatabase',
    id: taskDbId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: `NAS simulation tasks ${suffix}`,
    position: suffix + 1,
    seedRows: false,
  }, { timeoutMs: 20_000 }));
  assert(taskDatabase?.page?.id === taskDbId, 'task database must be created');
  createdPageIds.push(taskDbId);

  const projectTasksPropId = crypto.randomUUID();
  const taskEstimatePropId = crypto.randomUUID();
  const taskProjectPropId = crypto.randomUUID();
  const projectEstimateRollupId = crypto.randomUUID();
  await timed('create-relation-properties', () => callFunction(options.url, adminToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_properties',
    records: [
      {
        id: projectTasksPropId,
        databaseId: projectDbId,
        name: 'Tasks',
        type: 'relation',
        config: { relationDatabaseId: taskDbId },
        position: 1,
      },
      {
        id: taskEstimatePropId,
        databaseId: taskDbId,
        name: 'Estimate',
        type: 'number',
        config: {},
        position: 1,
      },
      {
        id: taskProjectPropId,
        databaseId: taskDbId,
        name: 'Project',
        type: 'relation',
        config: { relationDatabaseId: projectDbId },
        position: 2,
      },
    ],
  }, { timeoutMs: 20_000 }));
  await timed('create-rollup-property', () => callFunction(options.url, adminToken, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: projectEstimateRollupId,
      databaseId: projectDbId,
      name: 'Estimate sum',
      type: 'rollup',
      config: {
        rollupRelationPropertyId: projectTasksPropId,
        rollupTargetPropertyId: taskEstimatePropId,
        rollupFunction: 'sum',
      },
      position: 2,
    },
  }, { timeoutMs: 20_000 }));

  const projectRowId = crypto.randomUUID();
  await timed('create-project-row', () => callFunction(options.url, adminToken, 'database-row-mutation', {
    action: 'create',
    id: projectRowId,
    databaseId: projectDbId,
    title: 'Latency project',
  }, { timeoutMs: 20_000 }));
  const taskRows = [
    { id: crypto.randomUUID(), title: 'First task', estimate: 3 },
    { id: crypto.randomUUID(), title: 'Second task', estimate: 5 },
  ];
  for (const task of taskRows) {
    await timed(`create-${task.title.toLowerCase().replace(' ', '-')}`, () =>
      callFunction(options.url, adminToken, 'database-row-mutation', {
        action: 'create',
        id: task.id,
        databaseId: taskDbId,
        title: task.title,
        properties: {
          [taskEstimatePropId]: task.estimate,
          [taskProjectPropId]: [projectRowId],
        },
      }, { timeoutMs: 20_000 }));
  }

  const query = await timed('authoritative-rollup-query', () =>
    callFunction(options.url, adminToken, 'page-query', {
      action: 'databaseRows',
      databaseId: projectDbId,
      includeComputed: true,
    }, { timeoutMs: 20_000 }));
  const projectRow = query?.rows?.find((row) => row.id === projectRowId);
  const relatedTaskIds = Array.isArray(projectRow?.properties?.[projectTasksPropId])
    ? projectRow.properties[projectTasksPropId].map(String)
    : [];
  assert(taskRows.every((task) => relatedTaskIds.includes(task.id)), 'reciprocal relation must contain both task rows');
  const rollup = query?.computed?.[projectRowId]?.[projectEstimateRollupId];
  assert(rollup?.value === 8, `rollup sum must equal 8, received ${JSON.stringify(rollup)}`);

  return {
    relationRows: relatedTaskIds.length,
    rollupSum: rollup.value,
    timingsMs: timings,
  };

  async function timed(name, operation) {
    const startedAt = performance.now();
    const value = await operation();
    timings.push({ name, duration: Math.round(performance.now() - startedAt) });
    return value;
  }
}

async function setProxyEnabled(enabled) {
  const response = await fetchWithTimeout(
    resolveUrl(options.adminUrl, `/proxies/${options.proxyName}`),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ enabled }),
    },
    { timeoutMs: 5000 },
  );
  assert(response.ok, `setting simulation proxy enabled=${enabled} returned HTTP ${response.status}`);
}
