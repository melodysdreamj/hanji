#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assert,
  assertRuntimeReachable,
  callFunction,
  normalizeBaseUrl,
  signIn,
} from './lib/harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = normalizeBaseUrl(
  process.env.HANJI_EDGEBASE_URL
    ?? `http://127.0.0.1:${process.env.HANJI_SIM_PORT ?? 18787}`,
);
const definitions = {
  relations: ['scripts/database-relation-smoke.mjs', '--url', baseUrl, '--timeout-ms', '60000'],
  properties: ['scripts/database-property-edit-smoke.mjs', '--url', baseUrl, '--timeout-ms', '60000'],
  outbox: [
    'scripts/durable-outbox-ui-smoke.mjs',
    '--url', baseUrl,
    '--api-url', baseUrl,
    '--phases', 'C,F',
    '--timeout-ms', '60000',
  ],
  blocks: [
    'scripts/block-editor-ui-smoke.mjs',
    '--url', baseUrl,
    '--api-url', baseUrl,
    '--only-focus-flow',
    '--timeout-ms', '60000',
  ],
};

const requested = process.argv.slice(2);
if (requested.includes('--help') || requested.includes('-h')) {
  printHelp();
  process.exit(0);
}
const targets = requested.length > 0 ? requested : Object.keys(definitions);
for (const target of targets) {
  assert(Object.hasOwn(definitions, target), `unknown Synology smoke '${target}'`);
}

await assertRuntimeReachable(baseUrl, { timeoutMs: 15_000 });
console.log(`Existing smoke suite through Synology simulation: ${baseUrl}`);
const masterSession = await signIn(baseUrl, { mode: 'master', timeoutMs: 15_000 });
const originalLanguage = await callFunction(
  baseUrl,
  masterSession.accessToken,
  'account-state',
  { action: 'get' },
  { timeoutMs: 15_000 },
);
const restoreLanguage = originalLanguage?.languageOnboardingCompleted === true
  && typeof originalLanguage?.languagePreference === 'string'
  && originalLanguage.languagePreference;
if (restoreLanguage !== 'en') {
  await callWithRetry(
    baseUrl,
    masterSession.accessToken,
    'account-state',
    { action: 'setLanguagePreference', languagePreference: 'en' },
    { timeoutMs: 15_000 },
  );
}
try {
  for (const target of targets) {
    console.log(`\n=== Synology existing smoke: ${target} ===`);
    const result = spawnSync(process.execPath, definitions[target], {
      cwd: root,
      env: {
        ...process.env,
        HANJI_EDGEBASE_API_URL: baseUrl,
        HANJI_EDGEBASE_URL: baseUrl,
        HANJI_SMOKE_AUTH_MODE: 'master',
        HANJI_SMOKE_LANGUAGE: 'en',
      },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    assert(result.status === 0, `${target} smoke exited with status ${result.status}`);
  }
} finally {
  if (restoreLanguage && restoreLanguage !== 'en') {
    await callWithRetry(
      baseUrl,
      masterSession.accessToken,
      'account-state',
      { action: 'setLanguagePreference', languagePreference: restoreLanguage },
      { timeoutMs: 15_000 },
    );
  }
}
console.log(`\nPASS ${targets.join(', ')} existing smoke(s) completed through the Synology simulation.`);

async function callWithRetry(baseUrl, token, name, body, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await callFunction(baseUrl, token, name, body, options);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  throw lastError;
}

function printHelp() {
  console.log(`Run existing product smokes through the production-like Synology simulator.

Usage:
  npm run verify:synology-existing -- [relations] [properties] [outbox] [blocks]

With no targets, all four safe single-user content smokes run. The launcher
uses the simulator's synthetic master account because production Docker
correctly rejects anonymous bootstrap. Auth, provisioning, permissions, and
other account-lifecycle smokes remain isolated-runtime checks and are not
rewired to the durable master account.
`);
}
