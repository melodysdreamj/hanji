#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'backend');
const cliDist = process.env.HANJI_EDGEBASE_CLI_DIST ||
  join(backendDir, 'node_modules', '@edge-base', 'cli', 'dist');
const appBundleModule = join(cliDist, 'lib', 'app-bundle.js');
const dockerModule = join(cliDist, 'commands', 'docker.js');

if (!existsSync(appBundleModule) || !existsSync(dockerModule)) {
  throw new Error('EdgeBase CLI is not installed. Run `npm --prefix backend ci` first.');
}

let tag = 'hanji:latest';
let noCache = false;
let contextOnly = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--tag') {
    tag = process.argv[index + 1] || '';
    index += 1;
  } else if (arg === '--no-cache') {
    noCache = true;
  } else if (arg === '--context-only') {
    contextOnly = true;
  } else {
    throw new Error(`Unknown option: ${arg}`);
  }
}
if (!tag.trim()) throw new Error('--tag requires a non-empty value.');

const { createAppBundle } = await import(pathToFileURL(appBundleModule).href);
const { _internals } = await import(pathToFileURL(dockerModule).href);
if (!_internals?.finalizeDockerWrangler || !_internals?.prepareDockerBuildContext) {
  throw new Error('The pinned EdgeBase CLI does not expose the required Docker build helpers.');
}

const bundle = createAppBundle(backendDir, {
  outputDir: join('.edgebase', 'targets', 'docker-app'),
  overwrite: true,
  portableDependencies: true,
  dependencyProfile: 'docker',
});
_internals.finalizeDockerWrangler(backendDir, bundle.outputDir);
const contextDir = _internals.prepareDockerBuildContext(backendDir, bundle.outputDir);

if (contextOnly) {
  console.log(contextDir);
  process.exit(0);
}

const args = ['build', '-t', tag];
if (noCache) args.push('--no-cache');
args.push(contextDir);
const child = spawn('docker', args, { cwd: root, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
