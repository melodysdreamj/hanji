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
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'backend');
const webDir = join(root, 'web');
const localEdgebaseLinkScript = join(root, 'scripts', 'link-local-edgebase.mjs');
const releasePreflightScript = join(root, 'scripts', 'verify-release-config.mjs');
const fileSmokeScript = join(root, 'scripts', 'file-smoke.mjs');
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
  'share-mutation',
  'workspace-bootstrap',
  'workspace-mutation',
];

const spaFallbackRoutes = [
  '/',
  '/settings',
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
      'EdgeBase docker build',
      edgebaseBin,
      ['docker', 'build', '--tag', options.dockerTag],
      backendDir,
    );
    imageBuilt = true;
    const dockerBundleOutput = join(backendDir, '.edgebase', 'targets', 'docker-app');
    verifyOutput('docker-app', dockerBundleOutput);
    verifyDockerContext('docker-app', join(backendDir, '.edgebase', 'targets', 'docker-context'));

    if (options.dockerRuntime) {
      await verifyDockerRuntime(options);
    }
  } finally {
    if (imageBuilt) {
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
    skipLocalEdgebaseCheck: false,
    dockerPort: '',
    dockerTag: `notionlike-edgebase-verify:${Date.now()}`,
    bundleOutput: join(tmpdir(), 'notionlike-edgebase-app-verify'),
    packOutput: join(tmpdir(), 'notionlike-edgebase-pack-verify'),
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
  --docker-port <port>      Host port for runtime verification. Defaults to a free port.
  --bundle-output <path>    build-app output path. Defaults to a temp directory.
  --pack-output <path>      pack output path. Defaults to a temp directory.
`);
}

function run(label, command, args, cwd) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd,
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
  assert(
    dockerfile.includes('ENV CLOUDFLARE_INCLUDE_PROCESS_ENV=true'),
    `${label}: Dockerfile must forward container environment variables to Wrangler`,
  );
  assert(
    dockerfile.includes('rm -f /app/.dev.vars'),
    `${label}: Dockerfile must remove .dev.vars before enabling process-env bindings`,
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
    `PASS ${label}: index.html references ${assetRefs.length} built assets (${formatBytes(assetsSize)}).`,
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

async function verifyDockerRuntime(options) {
  const port = options.dockerPort || String(await findFreePort());
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const containerName = `notionlike-edgebase-verify-${suffix}`;
  const volumeName = `notionlike-edgebase-verify-${suffix}`;
  const envFile = join(tmpdir(), `notionlike-edgebase-verify-${suffix}.env`);
  const passwordFile = join(tmpdir(), `notionlike-edgebase-verify-${suffix}.password`);
  const password = `notionlike-Verify-${suffix}-password-123!`;

  writeFileSync(
    envFile,
    [
      `JWT_USER_SECRET=${randomBytes(32).toString('hex')}`,
      `JWT_ADMIN_SECRET=${randomBytes(32).toString('hex')}`,
      `SERVICE_KEY=${randomBytes(32).toString('hex')}`,
      'NOTIONLIKE_BUILD_SHA=docker-env-propagation-proof',
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
    try {
      // Notionlike intentionally permits anonymous bootstrap only from a
      // loopback client IP. A host-side request reaches the container through
      // Docker's bridge address and is therefore (correctly) denied. Run the
      // API smoke inside the container so it exercises the same local-only
      // policy as a directly operated self-hosted instance.
      const containerSmokePath = '/tmp/notionlike-file-smoke.mjs';
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
      ], root);
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

async function verifyPackRuntime(options) {
  const port = String(await findFreePort());
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dataDir = join(tmpdir(), `notionlike-edgebase-pack-data-${suffix}`);
  const persistDir = join(tmpdir(), `notionlike-edgebase-pack-persist-${suffix}`);
  const runScript = join(options.packOutput, process.platform === 'win32' ? 'run.cmd' : 'run.sh');
  const runtimeEnv = {
    ...process.env,
    CI: '1',
    JWT_USER_SECRET: process.env.JWT_USER_SECRET || randomBytes(32).toString('hex'),
    JWT_ADMIN_SECRET: process.env.JWT_ADMIN_SECRET || randomBytes(32).toString('hex'),
    SERVICE_KEY: process.env.SERVICE_KEY || randomBytes(32).toString('hex'),
    NOTIONLIKE_BUILD_SHA: 'pack-env-propagation-proof',
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
    try {
      run('pack runtime file/storage smoke', process.execPath, [
        fileSmokeScript,
        '--url',
        baseUrl,
        '--timeout-ms',
        '12000',
      ], root);
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
