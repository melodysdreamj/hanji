#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagingScript = resolve(root, 'scripts', 'verify-edgebase-packaging.mjs');

const options = parseArgs(process.argv.slice(2));
let generatedDockerTag = '';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL deployment verification: ${message}`);
  process.exitCode = 1;
} finally {
  cleanupGeneratedDockerImage();
}

async function main() {
  console.log('Deployment verification target: local EdgeBase-linked Notionlike app');

  if (!options.skipWebBuild) {
    run('web static build', 'npm', ['--prefix', 'web', 'run', 'build']);
  }

  if (!options.skipDocker) {
    assertDockerAvailable();
    if (!options.dockerTag) {
      generatedDockerTag = `notionlike-edgebase-verify:${Date.now()}`;
      options.dockerTag = generatedDockerTag;
    }
  }

  const args = [
    packagingScript,
    '--skip-web-build',
    '--pack-runtime',
    '--deploy-dry-run',
  ];

  if (!options.skipDocker) {
    args.push('--docker-runtime');
    if (options.dockerTag) args.push('--docker-tag', options.dockerTag);
    if (options.dockerPort) args.push('--docker-port', options.dockerPort);
  }

  run('EdgeBase pack/deploy/docker verification', process.execPath, args);

  console.log('\nPASS deployment verification suite completed.');
}

function assertDockerAvailable() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      'Docker is required for the default deployment verification. ' +
        'Start Docker or pass --skip-docker to verify pack runtime and deploy dry-run only.',
    );
  }
  const version = result.stdout.trim();
  console.log(`PASS Docker daemon is available (${version}).`);
}

function cleanupGeneratedDockerImage() {
  if (!generatedDockerTag || options.keepDockerImage) return;
  const result = spawnSync('docker', ['image', 'rm', '-f', generatedDockerTag], {
    cwd: root,
    stdio: 'ignore',
  });
  if (result.status === 0) {
    console.log(`PASS cleaned Docker verification image ${generatedDockerTag}.`);
  }
}

function run(label, command, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, CI: '1' },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function parseArgs(args) {
  const parsed = {
    skipWebBuild: false,
    skipDocker: false,
    keepDockerImage: false,
    dockerPort: '',
    dockerTag: '',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--skip-web-build') {
      parsed.skipWebBuild = true;
      continue;
    }
    if (arg === '--skip-docker') {
      parsed.skipDocker = true;
      continue;
    }
    if (arg === '--keep-docker-image') {
      parsed.keepDockerImage = true;
      continue;
    }
    if (arg === '--docker-port') {
      parsed.dockerPort = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--docker-tag') {
      parsed.dockerTag = resolveValue(args, i, arg);
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
  console.log(`Usage: node scripts/deployment-verify.mjs [options]

Runs the deployment-oriented Notionlike verification suite:
- web static build
- local EdgeBase link and app bundle checks
- edgebase pack --format dir runtime verification
- hosted deploy dry-run verification
- Docker image/context/runtime verification

Options:
  --skip-web-build       Reuse the existing web/dist bundle.
  --skip-docker          Verify pack runtime and deploy dry-run only.
  --keep-docker-image    Keep the generated Docker verification image.
  --docker-tag <tag>     Docker image tag. Defaults to a timestamped verification tag.
  --docker-port <port>   Host port for Docker runtime verification. Defaults to a free port.
`);
}
