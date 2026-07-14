#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'backend');
const webDir = join(root, 'web');
const localEdgebaseLinkScript = join(root, 'scripts', 'link-local-edgebase.mjs');
const releasePreflightScript = join(root, 'scripts', 'verify-release-config.mjs');
const fileSmokeScript = join(root, 'scripts', 'file-smoke.mjs');
const harnessScript = join(root, 'scripts', 'lib', 'harness.mjs');
const dockerBuildScript = join(root, 'scripts', 'build-hanji-docker-image.mjs');
const edgebaseBin = join(
  backendDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'edgebase.cmd' : 'edgebase',
);

const requiredFunctions = [
  'auth-audit',
  'block-mutation',
  'collaboration-mutation',
  'comment-mutation',
  'database-mutation',
  'database-row-mutation',
  'duplicate-page',
  'file-maintenance',
  'file-mutation',
  'health',
  'import-export',
  'notion-import',
  'notification-mutation',
  'page-mutation',
  'page-query',
  'runtime-config',
  'share-mutation',
  'sponsors',
  'workspace-bootstrap',
  'workspace-mutation',
];
const requiredLegalArtifacts = ['LICENSE', 'LICENSE-EXCEPTION', 'SOURCE-OFFER'];

const spaFallbackRoutes = [
  '/',
  '/settings',
  '/account',
  '/trash',
  '/p/packaging-runtime-proof',
  '/database/packaging-runtime-proof',
  '/workspace/packaging-runtime-proof',
  '/share/packaging-runtime-proof',
  '/share/packaging-runtime-proof?page=packaging-child&p=packaging-row',
];

const options = parseArgs(process.argv.slice(2));

run('release configuration preflight', process.execPath, [releasePreflightScript], root);

if (!options.skipLocalEdgebaseCheck) {
  run('local EdgeBase link check', process.execPath, [localEdgebaseLinkScript, '--check'], root);
}

if (options.runtimeImage) {
  await verifyRegistryFirstRun(options.runtimeImage);
  console.log('\nPASS image-only appliance runtime verification complete.');
  process.exit(0);
}

if (!options.skipWebBuild) {
  run('web static build', 'npm', ['run', 'build'], webDir);
}

cleanOutput(options.bundleOutput);
run('EdgeBase build-app', edgebaseBin, ['build-app', '--output', options.bundleOutput], backendDir);
verifyOutput('build-app', options.bundleOutput);

if (options.pack) {
  cleanOutput(options.packOutput);
  run(
    'EdgeBase pack',
    edgebaseBin,
    ['pack', '--format', 'dir', '--output', options.packOutput],
    backendDir,
  );
  verifyOutput('pack', options.packOutput);

  if (options.packRuntime) {
    await verifyPackRuntime(options);
  }
}

if (options.deployDryRun) {
  run(
    'EdgeBase deploy dry-run',
    edgebaseBin,
    ['--json', '--non-interactive', 'deploy', '--dry-run', '--bootstrap-admin-email', 'verify@example.test'],
    backendDir,
  );
  const deployDryRunOutput = join(backendDir, '.edgebase', 'targets', 'deploy-app-dry-run');
  verifyOutput('deploy-dry-run', deployDryRunOutput);
  verifyWranglerAssets('deploy-dry-run', join(deployDryRunOutput, 'wrangler.toml'));
}

if (options.docker) {
  let imageBuilt = false;
  try {
    run(
      'Hanji Docker build',
      process.execPath,
      [dockerBuildScript, '--tag', options.dockerTag],
      root,
    );
    imageBuilt = true;
    const dockerBundleOutput = join(backendDir, '.edgebase', 'targets', 'docker-app');
    verifyOutput('docker-app', dockerBundleOutput);
    verifyDockerContext('docker-app', join(backendDir, '.edgebase', 'targets', 'docker-context'));

    if (options.dockerRuntime) {
      await verifyDockerRuntime(options);
    }
  } finally {
    if (imageBuilt && !options.keepDockerImage) {
      runQuiet('docker cleanup image', 'docker', ['image', 'rm', '-f', options.dockerTag]);
    }
  }
}

console.log('\nPASS EdgeBase packaging verification complete.');

function parseArgs(args) {
  const parsed = {
    skipWebBuild: false,
    pack: false,
    packRuntime: false,
    deployDryRun: false,
    docker: false,
    dockerRuntime: false,
    keepDockerImage: false,
    runtimeImage: '',
    skipLocalEdgebaseCheck: false,
    dockerPort: '',
    dockerTag: `hanji-edgebase-verify:${Date.now()}`,
    bundleOutput: join(tmpdir(), 'hanji-edgebase-app-verify'),
    packOutput: join(tmpdir(), 'hanji-edgebase-pack-verify'),
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
    if (arg === '--skip-local-edgebase-check') {
      parsed.skipLocalEdgebaseCheck = true;
      continue;
    }
    if (arg === '--pack') {
      parsed.pack = true;
      continue;
    }
    if (arg === '--pack-runtime') {
      parsed.pack = true;
      parsed.packRuntime = true;
      continue;
    }
    if (arg === '--deploy-dry-run') {
      parsed.deployDryRun = true;
      continue;
    }
    if (arg === '--docker') {
      parsed.docker = true;
      continue;
    }
    if (arg === '--docker-runtime') {
      parsed.docker = true;
      parsed.dockerRuntime = true;
      continue;
    }
    if (arg === '--keep-docker-image') {
      parsed.keepDockerImage = true;
      continue;
    }
    if (arg === '--runtime-image') {
      parsed.runtimeImage = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--docker-tag') {
      parsed.dockerTag = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--docker-port') {
      parsed.dockerPort = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--bundle-output') {
      parsed.bundleOutput = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--pack-output') {
      parsed.packOutput = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  parsed.bundleOutput = resolve(parsed.bundleOutput);
  parsed.packOutput = resolve(parsed.packOutput);
  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${label} requires a path value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/verify-edgebase-packaging.mjs [options]

Options:
  --skip-web-build          Reuse the existing web/dist bundle.
  --skip-local-edgebase-check
                            Do not require @edge-base/* packages to be linked to the local EdgeBase checkout.
  --pack                    Also verify edgebase pack --format dir output.
  --pack-runtime            Build, run, and verify the portable directory pack.
  --deploy-dry-run          Verify the deploy dry-run app bundle.
  --docker                  Build and verify the EdgeBase Docker app bundle.
  --docker-runtime          Build, run, and verify the Docker container.
  --docker-tag <tag>        Docker image tag. Defaults to a timestamped tag.
  --runtime-image <tag>     Verify an already-built image's first-run and persistence contract.
  --keep-docker-image       Keep the verified image for a subsequent scan.
  --docker-port <port>      Host port for runtime verification. Defaults to a free port.
  --bundle-output <path>    build-app output path. Defaults to a temp directory.
  --pack-output <path>      pack output path. Defaults to a temp directory.
`);
}

function run(label, command, args, cwd, env = {}) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env, CI: '1' },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function cleanOutput(outputPath) {
  const absolute = resolve(outputPath);
  const allowedRoots = [
    resolve(tmpdir()),
    resolve(backendDir, 'dist'),
  ];
  const isAllowed = allowedRoots.some((allowedRoot) => isInside(absolute, allowedRoot));
  if (!isAllowed) {
    throw new Error(`Refusing to remove verification output outside temp/backend dist: ${absolute}`);
  }

  rmSync(absolute, { recursive: true, force: true });
  mkdirSync(dirname(absolute), { recursive: true });
}

function isInside(target, parent) {
  return target === parent || target.startsWith(`${parent}${process.platform === 'win32' ? '\\' : '/'}`);
}

function verifyOutput(label, outputPath) {
  const outputRoot = resolve(outputPath);
  assert(existsSync(outputRoot), `${label}: output directory does not exist: ${outputRoot}`);

  const appManifest = readJson(join(outputRoot, 'edgebase-app.json'));
  const frontend = appManifest.frontend ?? {};
  assert(frontend.enabled === true, `${label}: frontend.enabled must be true`);
  assert(frontend.mountPath === '/', `${label}: frontend.mountPath must be "/"`);
  assert(frontend.spaFallback === true, `${label}: frontend.spaFallback must be true`);
  console.log(`PASS ${label}: frontend is enabled at / with SPA fallback.`);

  const assetsDir = resolveFromManifest(outputRoot, appManifest.runtime?.assetsDir)
    ?? join(outputRoot, '.edgebase', 'runtime', 'server', 'app-assets');
  verifyFrontendAssets(label, assetsDir);

  const functionsDir = resolveFromManifest(outputRoot, appManifest.functions?.root)
    ?? join(outputRoot, '.edgebase', 'runtime', 'server', 'bundle', 'functions');
  verifyFunctions(label, appManifest, functionsDir);

  if (label === 'pack') {
    const packManifest = readJson(join(outputRoot, 'edgebase-pack.json'));
    assert(packManifest.format === 'dir', 'pack: edgebase-pack.json must describe a dir pack');
    assert(packManifest.projectName, 'pack: edgebase-pack.json must include the project name');
    assert(existsSync(join(outputRoot, 'run.sh')), 'pack: run.sh must be present');
    console.log(`PASS ${label}: portable pack metadata and launcher are present.`);
  }
}

function verifyDockerContext(label, contextDir) {
  const dockerfilePath = join(contextDir, 'Dockerfile');
  assert(existsSync(dockerfilePath), `${label}: Docker build context is missing Dockerfile`);
  assert(
    existsSync(join(contextDir, '.edgebase', 'targets', 'docker-app', 'edgebase-app.json')),
    `${label}: Docker build context is missing the EdgeBase app bundle`,
  );
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const entrypointPath = join(contextDir, 'edgebase-entrypoint.mjs');
  assert(existsSync(entrypointPath), `${label}: Docker build context is missing the app entrypoint`);
  const entrypoint = readFileSync(entrypointPath, 'utf8');
  assert(
    entrypoint.includes('EDGEBASE_CONFIG_ENV_ALLOWLIST') &&
      entrypoint.includes("name.startsWith('HANJI_')") &&
      entrypoint.includes('for (const name of secretNames)') &&
      entrypoint.includes("const devVarsPath = '/app/.dev.vars'") &&
      entrypoint.includes('mode: 0o600'),
    `${label}: entrypoint must expose only image-managed secrets and named HANJI settings to EdgeBase`,
  );
  assert(
    !dockerfile.includes('ENV CLOUDFLARE_INCLUDE_PROCESS_ENV=true') &&
      !entrypoint.includes("CLOUDFLARE_INCLUDE_PROCESS_ENV ||= 'true'"),
    `${label}: container must not expose its complete process environment to the Worker`,
  );
  assert(
    entrypoint.includes("runtime-secrets.json") && entrypoint.includes("mode: 0o600"),
    `${label}: Dockerfile must persist private image-managed runtime secrets`,
  );
  assert(
    dockerfile.includes('apt-get install -y --no-install-recommends ca-certificates'),
    `${label}: Dockerfile must include the system CA bundle for outbound HTTPS`,
  );
  assert(
    dockerfile.includes('ENV LOCAL_PROTOCOL=http'),
    `${label}: Dockerfile must default to reverse-proxy-friendly HTTP ingress`,
  );
  assert(
    dockerfile.includes('VOLUME ["/data"]'),
    `${label}: Dockerfile must provide an automatic persistent data volume`,
  );
  console.log(`PASS ${label}: Docker build context includes the generated app bundle.`);
}

function verifyWranglerAssets(label, wranglerTomlPath) {
  assert(existsSync(wranglerTomlPath), `${label}: wrangler.toml is missing`);
  const wranglerDir = dirname(wranglerTomlPath);
  const wranglerToml = readFileSync(wranglerTomlPath, 'utf8');

  const workerEntry = readTomlString(wranglerToml, 'main');
  assert(workerEntry, `${label}: wrangler.toml is missing worker main entry`);
  assert(
    existsSync(resolve(wranglerDir, workerEntry)),
    `${label}: wrangler.toml worker main does not exist: ${workerEntry}`,
  );

  const assetsSection = readTomlSection(wranglerToml, 'assets');
  assert(assetsSection, `${label}: wrangler.toml is missing [assets]`);

  const assetsDirectory = readTomlString(assetsSection, 'directory');
  assert(
    normalizeConfigPath(assetsDirectory) === '.edgebase/runtime/server/app-assets',
    `${label}: wrangler.toml assets directory does not point at app-assets`,
  );
  assert(
    readTomlString(assetsSection, 'binding') === 'ASSETS',
    `${label}: wrangler.toml assets binding must be ASSETS`,
  );
  assert(
    readTomlBoolean(assetsSection, 'run_worker_first') === true,
    `${label}: wrangler.toml assets must run the worker first`,
  );

  verifyFrontendAssets(`${label} wrangler-assets`, resolve(wranglerDir, assetsDirectory));
  console.log(
    `PASS ${label}: wrangler.toml connects worker-first hosting to the packaged SPA assets.`,
  );
}

function verifyFrontendAssets(label, assetsDir) {
  assert(existsSync(assetsDir), `${label}: frontend assets directory is missing: ${assetsDir}`);

  const indexPath = join(assetsDir, 'index.html');
  assert(existsSync(indexPath), `${label}: index.html is missing from frontend assets`);

  const html = readFileSync(indexPath, 'utf8');
  assert(/<div[^>]+id=["']root["']/.test(html), `${label}: index.html must contain the SPA root`);

  for (const artifact of requiredLegalArtifacts) {
    assert(
      existsSync(join(assetsDir, artifact)),
      `${label}: required legal artifact is missing from the distributable: ${artifact}`,
    );
  }
  assert(
    readFileSync(join(assetsDir, 'LICENSE'), 'utf8').includes('GNU AFFERO GENERAL PUBLIC LICENSE'),
    `${label}: LICENSE is not the AGPL-3.0 text`,
  );
  assert(
    readFileSync(join(assetsDir, 'LICENSE-EXCEPTION'), 'utf8').includes('Hanji Sponsor Banner Exception'),
    `${label}: LICENSE-EXCEPTION is not the Hanji exception text`,
  );
  const sourceOffer = readFileSync(join(assetsDir, 'SOURCE-OFFER'), 'utf8');
  for (const envName of [
    'HANJI_SOURCE_URL',
    'HANJI_AGPL_LICENSE_URL',
    'HANJI_SPONSOR_EXCEPTION_URL',
  ]) {
    assert(
      sourceOffer.includes(envName),
      `${label}: SOURCE-OFFER must explain ${envName}`,
    );
  }

  const assetRefs = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith('/assets/'))
    .map((value) => value.replace(/[?#].*$/, '').replace(/^\//, ''));

  assert(assetRefs.length > 0, `${label}: index.html does not reference Vite assets`);

  const missingAssets = assetRefs.filter((assetRef) => !existsSync(join(assetsDir, assetRef)));
  assert(
    missingAssets.length === 0,
    `${label}: missing referenced frontend assets: ${missingAssets.join(', ')}`,
  );

  const referencedExtensions = new Set(assetRefs.map((assetRef) => extname(assetRef)));
  assert(referencedExtensions.has('.js'), `${label}: frontend JS bundle is not referenced`);
  assert(referencedExtensions.has('.css'), `${label}: frontend CSS bundle is not referenced`);

  const assetsSize = directorySize(assetsDir);
  assert(assetsSize > 0, `${label}: frontend assets directory is empty`);
  console.log(
    `PASS ${label}: index.html references ${assetRefs.length} built assets and all legal artifacts (${formatBytes(assetsSize)}).`,
  );
}

function verifyFunctions(label, appManifest, functionsDir) {
  assert(existsSync(functionsDir), `${label}: function bundle directory is missing: ${functionsDir}`);
  const missingFunctions = requiredFunctions.filter(
    (functionName) => !existsSync(join(functionsDir, `${functionName}.js`)),
  );
  assert(
    missingFunctions.length === 0,
    `${label}: missing bundled functions: ${missingFunctions.join(', ')}`,
  );

  const manifestCount = appManifest.functions?.count;
  if (typeof manifestCount === 'number') {
    assert(
      manifestCount >= requiredFunctions.length,
      `${label}: functions.count is lower than expected (${manifestCount})`,
    );
  }

  console.log(`PASS ${label}: ${requiredFunctions.length} required backend functions are bundled.`);
}

function resolveFromManifest(outputRoot, maybeRelativePath) {
  if (!maybeRelativePath || typeof maybeRelativePath !== 'string') return null;
  return resolve(outputRoot, maybeRelativePath);
}

function readTomlSection(toml, sectionName) {
  const pattern = new RegExp(
    `(?:^|\\n)\\[${escapeRegExp(sectionName)}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`,
  );
  return pattern.exec(toml)?.[1] ?? '';
}

function readTomlString(toml, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']\\s*$`, 'm');
  return pattern.exec(toml)?.[1] ?? '';
}

function readTomlBoolean(toml, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*$`, 'm');
  const value = pattern.exec(toml)?.[1];
  if (!value) return null;
  return value === 'true';
}

function normalizeConfigPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readJson(path) {
  assert(existsSync(path), `Missing JSON file: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function directorySize(path) {
  let total = 0;
  for (const entry of readdirSync(path)) {
    const next = join(path, entry);
    const stat = statSync(next);
    if (stat.isDirectory()) {
      total += directorySize(next);
    } else {
      total += stat.size;
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function printDockerLogs(containerName) {
  const result = spawnSync('docker', ['logs', '--tail', '120', containerName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  console.error(output || '(no docker logs captured)');
}

function assertContainerCaBundle(containerName, label) {
  run(`${label} system CA bundle`, 'docker', [
    'exec',
    containerName,
    'sh',
    '-lc',
    'test -s /etc/ssl/certs/ca-certificates.crt',
  ], root);
}

async function verifyDockerRuntime(options) {
  const port = options.dockerPort || String(await findFreePort());
  const suffix = `${Date.now()}-${randomBytes(5).toString('hex')}`;
  const containerName = `hanji-edgebase-verify-${suffix}`;
  const volumeName = `hanji-edgebase-verify-${suffix}`;
  const envFile = join(tmpdir(), `hanji-edgebase-verify-${suffix}.env`);
  const passwordFile = join(tmpdir(), `hanji-edgebase-verify-${suffix}.password`);
  const password = `hanji-Verify-${suffix}-password-123!`;

  writeFileSync(
    envFile,
    [
      `JWT_USER_SECRET=${randomBytes(32).toString('hex')}`,
      `JWT_ADMIN_SECRET=${randomBytes(32).toString('hex')}`,
      `SERVICE_KEY=${randomBytes(32).toString('hex')}`,
      'LOCAL_PROTOCOL=http',
      'HANJI_BUILD_SHA=docker-env-propagation-proof',
      // The registry-style check below covers the common browser setup. Keep
      // one environment-provisioned runtime here as a compatibility guard for
      // operators that still need noninteractive initialization.
      'HANJI_MASTER_EMAIL=docker-master@example.test',
      `HANJI_MASTER_PASSWORD=Docker-${suffix}-Master!7`,
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(envFile, 0o600);
  writeFileSync(passwordFile, password, 'utf8');
  chmodSync(passwordFile, 0o600);

  try {
    run(
      'EdgeBase docker run',
      edgebaseBin,
      [
        'docker',
        'run',
        '--tag',
        options.dockerTag,
        '--port',
        port,
        '--volume',
        volumeName,
        '--name',
        containerName,
        '--detach',
        '--env-file',
        envFile,
        '--bootstrap-admin-email',
        'verify@example.test',
        '--bootstrap-admin-password-file',
        passwordFile,
      ],
      backendDir,
    );

    const baseUrl = `http://127.0.0.1:${port}`;
    await assertSpaFallbackRoutes(baseUrl, 'docker-runtime');
    await assertRuntimeEnvironment(baseUrl, 'docker-env-propagation-proof', 'docker-runtime');
    await assertMasterBootstrap(baseUrl, 'docker-runtime');
    assertContainerCaBundle(containerName, 'docker-runtime');
    try {
      // Hanji intentionally permits anonymous bootstrap only from a
      // loopback client IP. A host-side request reaches the container through
      // Docker's bridge address and is therefore (correctly) denied. Run the
      // API smoke inside the container so it exercises the same local-only
      // policy as a directly operated self-hosted instance.
      const containerSmokePath = '/tmp/hanji-file-smoke.mjs';
      run('prepare shared smoke harness directory in Docker runtime', 'docker', [
        'exec', containerName, 'mkdir', '-p', '/tmp/lib',
      ], root);
      run('copy shared smoke harness into Docker runtime', 'docker', [
        'cp', harnessScript, `${containerName}:/tmp/lib/harness.mjs`,
      ], root);
      run('copy file/storage smoke into Docker runtime', 'docker', [
        'cp',
        fileSmokeScript,
        `${containerName}:${containerSmokePath}`,
      ], root);
      run('docker runtime file/storage smoke', 'docker', [
        'exec',
        containerName,
        'node',
        containerSmokePath,
        '--url',
        'http://127.0.0.1:8787',
        '--timeout-ms',
        '12000',
        '--password-signup',
      ], root);
      await verifyRegistryFirstRun(options.dockerTag);
      await verifyBindMountPersistence(options.dockerTag);
    } catch (error) {
      console.error('\nDocker runtime logs before file/storage smoke failure:');
      printDockerLogs(containerName);
      throw error;
    }
  } finally {
    runQuiet('docker cleanup container', 'docker', ['rm', '-f', containerName]);
    runQuiet('docker cleanup volume', 'docker', ['volume', 'rm', '-f', volumeName]);
    rmSync(envFile, { force: true });
    rmSync(passwordFile, { force: true });
  }
}

async function verifyBindMountPersistence(imageTag) {
  const port = String(await findFreePort());
  const suffix = `${Date.now()}-${randomBytes(5).toString('hex')}`;
  const containerName = `hanji-bind-verify-${suffix}`;
  const bindDir = join(backendDir, '.edgebase', 'targets', `hanji-bind-verify-${suffix}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  mkdirSync(bindDir, { recursive: true, mode: 0o755 });

  const start = () => run('bind-mount Docker run (host-owned /data)', 'docker', [
    'run', '-d',
    '--name', containerName,
    '-p', `127.0.0.1:${port}:8787`,
    '-v', `${bindDir}:/data`,
    imageTag,
  ], root);

  try {
    start();
    await waitForDockerRuntimeReady(baseUrl, containerName);
    const processList = spawnSync(
      'docker',
      ['top', containerName, '-eo', 'pid,user,group,comm,args'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert(processList.status === 0, 'could not inspect bind-mount runtime processes');
    assert(
      processList.stdout.split('\n').some((line) => line.includes('10001') && line.includes('edgebase-entrypoint.mjs')),
      'bind-mount runtime did not drop the application process to uid 10001',
    );
    const secret = readContainerRuntimeSecret(containerName, 'JWT_USER_SECRET');
    run('remove bind-mount container for persistence replay', 'docker', ['rm', '-f', containerName], root);
    start();
    await waitForDockerRuntimeReady(baseUrl, containerName);
    assert(
      readContainerRuntimeSecret(containerName, 'JWT_USER_SECRET') === secret,
      'bind-mount runtime rotated its secret after container recreation',
    );
    console.log('PASS dedicated host bind mounts are prepared, run as uid 10001, and survive recreation.');
  } catch (error) {
    console.error('\nBind-mount Docker logs before failure:');
    printDockerLogs(containerName);
    throw error;
  } finally {
    runQuiet('bind-mount Docker cleanup container', 'docker', ['rm', '-f', containerName]);
    if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      runQuiet('bind-mount ownership cleanup', 'docker', [
        'run', '--rm', '--user', '0:0', '--entrypoint', 'chown',
        '-v', `${bindDir}:/data`, imageTag,
        '-R', `${process.getuid()}:${process.getgid()}`, '/data',
      ]);
    }
    rmSync(bindDir, { recursive: true, force: true });
  }
}

async function verifyRegistryFirstRun(imageTag) {
  const port = String(await findFreePort());
  const suffix = `${Date.now()}-${randomBytes(5).toString('hex')}`;
  const containerName = `hanji-registry-verify-${suffix}`;
  const volumeName = `hanji-registry-verify-${suffix}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const email = `registry-owner-${suffix}@example.test`;
  const password = `Registry-${suffix}-Owner!7`;

  const start = () => run('registry-style Docker run (no secret/master env)', 'docker', [
    'run', '-d',
    '--name', containerName,
    '-p', `127.0.0.1:${port}:8787`,
    '-v', `${volumeName}:/data`,
    imageTag,
  ], root);

  try {
    start();
    await waitForDockerRuntimeReady(baseUrl, containerName);
    assertContainerCaBundle(containerName, 'registry-style Docker runtime');

    const inspect = spawnSync('docker', ['inspect', containerName, '--format', '{{json .Config.Env}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert(inspect.status === 0, 'registry runtime Docker inspect failed');
    for (const name of [
      'JWT_USER_SECRET',
      'JWT_ADMIN_SECRET',
      'SERVICE_KEY',
      'HANJI_NOTION_IMPORT_SECRET',
      'HANJI_MCP_OAUTH_SECRET',
      'HANJI_SETUP_TOKEN',
    ]) {
      assert(!inspect.stdout.includes(`${name}=`), `registry runtime leaked generated ${name} into Docker config env`);
    }

    const statusBefore = await fetchJsonResponse(`${baseUrl}/api/functions/instance-bootstrap`);
    assert(statusBefore.response.ok, 'registry runtime bootstrap status failed');
    assert(statusBefore.json.setupAvailable === true, 'fresh registry runtime did not offer web setup');
    assert(statusBefore.json.setupCodeRequired === false, 'fresh registry runtime still required a terminal setup code');
    assert(!('setupCode' in statusBefore.json), 'registry runtime exposed an obsolete setup-code field');
    assert(
      !readContainerRuntimeSecret(containerName, 'HANJI_SETUP_TOKEN'),
      'registry runtime persisted the obsolete terminal setup token',
    );

    const initialized = await fetchJsonResponse(`${baseUrl}/api/functions/instance-bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action: 'completeSetup', email, password }),
    });
    assert(initialized.response.status === 201, `registry setup returned HTTP ${initialized.response.status}: ${JSON.stringify(initialized.json)}`);
    const firstRunSession = await assertPasswordSignin(baseUrl, email, password, 'registry first-run');
    await assertNotionConnectionStorageAvailable(
      baseUrl,
      firstRunSession.accessToken,
      'registry first-run',
    );
    await assertBrowserCookiePasswordSignin(baseUrl, email, password, 'registry localhost browser');
    await assertBrowserCookiePasswordSignin(
      baseUrl,
      email,
      password,
      'registry trusted HTTPS proxy browser',
      'https://hanji.example.test',
    );

    const persistedUserSecret = readContainerRuntimeSecret(containerName, 'JWT_USER_SECRET');
    run('remove registry-style container for persistence replay', 'docker', ['rm', '-f', containerName], root);
    start();
    await waitForDockerRuntimeReady(baseUrl, containerName);
    assert(
      readContainerRuntimeSecret(containerName, 'JWT_USER_SECRET') === persistedUserSecret,
      'registry runtime rotated its /data-persisted JWT secret after recreation',
    );
    const statusAfter = await fetchJsonResponse(`${baseUrl}/api/functions/instance-bootstrap`);
    assert(statusAfter.response.ok, 'recreated registry runtime bootstrap status failed');
    assert(statusAfter.json.setupAvailable === false, 'recreated registry runtime reopened first-run setup');
    assert(statusAfter.json.setupBlocked === false, 'recreated registry runtime became setup-blocked');
    const recreatedSession = await assertPasswordSignin(baseUrl, email, password, 'recreated registry runtime');
    await assertNotionConnectionStorageAvailable(
      baseUrl,
      recreatedSession.accessToken,
      'recreated registry runtime',
    );
    await assertBrowserCookiePasswordSignin(baseUrl, email, password, 'recreated registry localhost browser');
    console.log('PASS registry-style image offers zero-terminal browser setup, claims the first admin, and preserves it across recreation.');
  } catch (error) {
    console.error('\nRegistry-style Docker logs before failure:');
    printDockerLogs(containerName);
    throw error;
  } finally {
    runQuiet('registry Docker cleanup container', 'docker', ['rm', '-f', containerName]);
    runQuiet('registry Docker cleanup volume', 'docker', ['volume', 'rm', '-f', volumeName]);
  }
}

function readContainerRuntimeSecret(containerName, name) {
  const script = [
    'const fs=require("fs")',
    'const p=(process.env.PERSIST_DIR||"/data")+"/.hanji/runtime-secrets.json"',
    `process.stdout.write(String(JSON.parse(fs.readFileSync(p,"utf8"))[${JSON.stringify(name)}]||""))`,
  ].join(';');
  const result = spawnSync('docker', ['exec', containerName, 'node', '-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(result.status === 0, `could not read persisted ${name} inside registry runtime`);
  return result.stdout.trim();
}

async function fetchJsonResponse(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${url} did not return JSON: ${text.slice(0, 200)}`);
  }
  return { response, json };
}

async function fetchJsonResponseThroughProxy(upstreamUrl, publicOrigin, options = {}) {
  const upstream = new URL(upstreamUrl);
  const payload = options.body ?? '';
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      hostname: upstream.hostname,
      port: upstream.port,
      path: `${upstream.pathname}${upstream.search}`,
      method: options.method ?? 'GET',
      headers: {
        ...options.headers,
        Host: new URL(publicOrigin).host,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error(`${upstreamUrl} did not return JSON: ${text.slice(0, 200)}`));
          return;
        }
        resolvePromise({
          response: {
            ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
            status: response.statusCode ?? 500,
            headers: new Headers(response.headers),
          },
          json,
        });
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error('proxy simulation timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

async function assertPasswordSignin(baseUrl, email, password, label) {
  const { response, json } = await fetchJsonResponse(`${baseUrl}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert(response.ok, `${label} sign-in returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  assert(typeof json.accessToken === 'string' && json.accessToken, `${label} sign-in returned no access token`);
  return json;
}

async function assertNotionConnectionStorageAvailable(baseUrl, accessToken, label) {
  const request = async (functionName, body) => fetchJsonResponse(`${baseUrl}/api/functions/${functionName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const bootstrap = await request('workspace-bootstrap', {});
  assert(
    bootstrap.response.ok && typeof bootstrap.json?.workspace?.id === 'string',
    `${label} workspace bootstrap failed: HTTP ${bootstrap.response.status} ${JSON.stringify(bootstrap.json)}`,
  );
  const connections = await request('notion-import', {
    action: 'listConnections',
    workspaceId: bootstrap.json.workspace.id,
    limit: 1,
  });
  assert(
    connections.response.ok,
    `${label} Notion connection listing failed: HTTP ${connections.response.status} ${JSON.stringify(connections.json)}`,
  );
  assert(
    connections.json.connectionStorageAvailable === true,
    `${label} did not expose the image-managed Notion encryption secret to the Worker`,
  );
}

async function assertBrowserCookiePasswordSignin(
  baseUrl,
  email,
  password,
  label,
  publicOrigin = baseUrl,
) {
  const publicUrl = new URL(publicOrigin);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: publicOrigin,
    'X-EdgeBase-Auth-Transport': 'cookie',
  };
  if (publicUrl.protocol === 'https:') {
    headers.Host = publicUrl.host;
    headers['X-Forwarded-Proto'] = 'https';
  }
  const requestOptions = {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  };
  const { response, json } = publicUrl.protocol === 'https:'
    ? await fetchJsonResponseThroughProxy(
      `${baseUrl}/api/auth/signin`,
      publicOrigin,
      requestOptions,
    )
    : await fetchJsonResponse(`${baseUrl}/api/auth/signin`, requestOptions);
  assert(response.ok, `${label} sign-in returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  assert(typeof json.accessToken === 'string' && json.accessToken, `${label} returned no access token`);
  assert(!('refreshToken' in json), `${label} exposed the refresh credential to browser JavaScript`);
  assert(json.sessionTransport === 'cookie', `${label} did not negotiate HttpOnly cookie transport`);
  const cookie = response.headers.get('set-cookie') || '';
  assert(cookie.includes('HttpOnly'), `${label} did not issue an HttpOnly refresh cookie`);
  if (publicUrl.protocol === 'https:') {
    assert(cookie.includes('__Host-hanji-refresh='), `${label} did not issue a host-only HTTPS cookie`);
    assert(cookie.includes('Secure'), `${label} did not mark the HTTPS cookie Secure`);
  } else {
    assert(cookie.includes('hanji-refresh='), `${label} did not issue the localhost refresh cookie`);
    assert(!cookie.includes('Secure'), `${label} issued an unusable Secure cookie over localhost HTTP`);
  }
}

async function waitForDockerRuntimeReady(baseUrl, containerName) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // Continue until ready or timeout.
    }
    await delay(500);
  }
  printDockerLogs(containerName);
  throw new Error('registry-style Docker runtime did not become ready within 45000ms.');
}

async function verifyPackRuntime(options) {
  const port = String(await findFreePort());
  const suffix = `${Date.now()}-${randomBytes(5).toString('hex')}`;
  const dataDir = join(tmpdir(), `hanji-edgebase-pack-data-${suffix}`);
  const persistDir = join(tmpdir(), `hanji-edgebase-pack-persist-${suffix}`);
  const runScript = join(options.packOutput, process.platform === 'win32' ? 'run.cmd' : 'run.sh');
  const runtimeEnv = {
    ...process.env,
    CI: '1',
    JWT_USER_SECRET: process.env.JWT_USER_SECRET || randomBytes(32).toString('hex'),
    JWT_ADMIN_SECRET: process.env.JWT_ADMIN_SECRET || randomBytes(32).toString('hex'),
    SERVICE_KEY: process.env.SERVICE_KEY || randomBytes(32).toString('hex'),
    EDGEBASE_RUNTIME_ENV_ALLOWLIST: [
      process.env.EDGEBASE_RUNTIME_ENV_ALLOWLIST,
      'HANJI_BUILD_SHA',
      'HANJI_MASTER_EMAIL',
      'HANJI_MASTER_PASSWORD',
    ].filter(Boolean).join(','),
    HANJI_BUILD_SHA: 'pack-env-propagation-proof',
    // Master account travels as process env on packed/self-hosted runtimes.
    HANJI_MASTER_EMAIL: 'pack-master@example.test',
    HANJI_MASTER_PASSWORD: `Pack-${randomBytes(6).toString('hex')}-Master!7`,
  };
  const logs = [];

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(persistDir, { recursive: true });

  console.log('\n> EdgeBase pack runtime');
  const child = spawn(
    runScript,
    [
      '--host',
      '127.0.0.1',
      '--port',
      port,
      '--data-dir',
      dataDir,
      '--persist-to',
      persistDir,
    ],
    {
      cwd: options.packOutput,
      env: runtimeEnv,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const capture = (chunk) => {
    logs.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const exited = new Promise((resolvePromise) => {
    child.once('error', (error) => {
      resolvePromise({ type: 'error', error });
    });
    child.once('exit', (code, signal) => {
      resolvePromise({ type: 'exit', code, signal });
    });
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const ready = waitForPackRuntimeReady(baseUrl, logs).then(() => ({ type: 'ready' }));
    const result = await Promise.race([ready, exited]);
    if (result.type === 'error') {
      throw result.error;
    }
    if (result.type === 'exit') {
      throw new Error(
        `pack runtime exited before becoming ready (code ${result.code}, signal ${result.signal}).`,
      );
    }
    await assertSpaFallbackRoutes(baseUrl, 'pack-runtime');
    await assertRuntimeEnvironment(baseUrl, 'pack-env-propagation-proof', 'pack-runtime');
    await assertMasterBootstrap(baseUrl, 'pack-runtime');
    try {
      run('pack runtime file/storage smoke', process.execPath, [
        fileSmokeScript,
        '--url',
        baseUrl,
        '--timeout-ms',
        '12000',
        '--password-signup',
      ], root, {
        HANJI_MASTER_EMAIL: runtimeEnv.HANJI_MASTER_EMAIL,
        HANJI_MASTER_PASSWORD: runtimeEnv.HANJI_MASTER_PASSWORD,
      });
    } catch (error) {
      console.error('\nPack runtime logs before file/storage smoke failure:');
      console.error(logs.slice(-80).join('\n') || '(no runtime logs captured)');
      throw error;
    }
  } finally {
    await stopProcess(child);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(persistDir, { recursive: true, force: true });
  }
}

// Non-dev deployments (Docker, packed self-host, Cloudflare) receive the
// master account as environment variables; the runtime must provision it on
// first boot without any interactive setup step.
async function assertMasterBootstrap(baseUrl, label) {
  // A brand-new runtime may still be settling (auth schema, DO warm-up), so
  // give the idempotent ensure a few attempts before declaring failure.
  let json;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/functions/instance-bootstrap`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`${label}: instance-bootstrap returned HTTP ${response.status}`);
    }
    json = await response.json();
    if (json.masterConfigured === true && json.masterReady === true && json.setupBlocked === false) {
      // This endpoint is public. Loopback-looking URL/Host metadata is not peer
      // authentication, so master identity and credentials must never be echoed.
      if ('masterEmail' in json || 'password' in json) {
        throw new Error(`${label}: instance-bootstrap exposed master credential metadata`);
      }
      console.log(`PASS ${label} provisions the master account from environment variables.`);
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2500));
  }
  throw new Error(
    `${label}: master account was not provisioned from container/runtime env: ${JSON.stringify(json)}`,
  );
}

async function assertRuntimeEnvironment(baseUrl, expectedBuildSha, label) {
  const response = await fetch(`${baseUrl}/api/functions/health`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.text();
  assert(response.ok, `${label}: product health returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`${label}: product health did not return JSON: ${body.slice(0, 200)}`);
  }
  assert(
    json.buildSha === expectedBuildSha,
    `${label}: arbitrary container/runtime environment variables did not reach the worker`,
  );
  console.log(`PASS ${label}: application-specific environment variables reach the worker.`);
}

async function waitForPackRuntimeReady(baseUrl, logs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return;
    } catch {
      // keep polling until the runtime is ready or the timeout expires
    }
    await delay(500);
  }
  throw new Error(`pack runtime did not become ready within 30000ms.\n${logs.slice(-60).join('\n')}`);
}

async function assertSpaFallbackRoutes(baseUrl, label) {
  for (const route of spaFallbackRoutes) {
    await assertHtmlRoute(baseUrl, route, label);
  }
  console.log(
    `PASS ${label}: SPA fallback routes (${spaFallbackRoutes.join(', ')}) respond from ${baseUrl}.`,
  );
}

async function assertHtmlRoute(baseUrl, path, label) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(5_000),
  });
  assert(response.ok, `${label}: ${path} returned HTTP ${response.status}`);
  const body = await response.text();
  assert(/<div[^>]+id=["']root["']/.test(body), `${label}: ${path} did not return SPA HTML`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  child.kill('SIGTERM');
  const result = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    delay(5_000).then(() => 'timeout'),
  ]);
  if (result === 'timeout' && child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

function runQuiet(label, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const detail = result.error?.message
      ?? [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      ?? `exit status ${result.status}`;
    console.warn(`WARN ${label} failed (status ${result.status}): ${detail || 'no output'}`);
  }
}

async function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolvePromise(address.port);
          return;
        }
        reject(new Error('Could not allocate a free localhost port.'));
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
