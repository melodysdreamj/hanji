import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyPersistenceUpgrade,
  commitPersistenceFormat,
  inspectPersistenceFormat,
  parsePersistedRuntimeSecrets,
} from './persistence-format.mjs';
import { assertRuntimeDataDirectoryAccess } from './data-directory-access.mjs';
import { serializeEdgeBaseConfigModule } from './runtime-config.mjs';

const appRoot = '/app';
const appManifestPath = join(appRoot, 'edgebase-app.json');
const controlRoot = '/__edgebase/internal/self-host';
const runtimePrebuildTimeoutMs = 180_000;
const runtimePrebuildMaxBytes = 64 * 1024 * 1024;
const runtimePrebuildGroupShutdownTimeoutMs = 2_000;
const startupTimeoutMs = boundedInteger(
  process.env.HANJI_STARTUP_TIMEOUT_MS || '300000',
  'HANJI_STARTUP_TIMEOUT_MS',
  60_000,
  1_800_000,
);
const shutdownTimeoutMs = boundedInteger(
  process.env.HANJI_SHUTDOWN_TIMEOUT_MS || '15000',
  'HANJI_SHUTDOWN_TIMEOUT_MS',
  1_000,
  300_000,
);
const persistDir = process.env.PERSIST_DIR || '/data';
const host = process.env.HOST || '0.0.0.0';
const port = positivePort(process.env.PORT || '8787', 'PORT');
const internalPort = positivePort(
  process.env.EDGEBASE_INTERNAL_PORT || '8788',
  'EDGEBASE_INTERNAL_PORT',
);
const wranglerConfig = process.env.WRANGLER_CONFIG || 'wrangler.toml';
const protocol = process.env.LOCAL_PROTOCOL || 'http';
const runtimeUid = Number(process.env.EDGEBASE_UID || '10001');
const runtimeGid = Number(process.env.EDGEBASE_GID || '10001');
const minimumFreeKilobytes = Number(process.env.HANJI_DOCKER_MIN_FREE_KB || '524288');
const secretDir = join(persistDir, '.hanji');
const secretFile = join(secretDir, 'runtime-secrets.json');
const scheduleStateFile = join(secretDir, 'self-host-schedule-state.json');
const generatedConfigPath = '/app/.edgebase/runtime/server/src/generated-config.ts';
const generatedConfigSource = serializeEdgeBaseConfigModule(process.env.EDGEBASE_CONFIG);
const secretNames = [
  'JWT_USER_SECRET',
  'JWT_ADMIN_SECRET',
  'SERVICE_KEY',
  'HANJI_NOTION_IMPORT_SECRET',
  'HANJI_MCP_OAUTH_SECRET',
];

function prebuildSelfHostRuntime({
  appRoot: runtimeAppRoot = appRoot,
  configPath = wranglerConfig,
  temporaryRoot = process.env.TMPDIR || '/tmp',
  wranglerCommand = 'wrangler',
  wranglerArgsPrefix = [],
} = {}) {
  const processGroupAlive = (pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (error?.code === 'ESRCH' || error?.code === 'EPERM') return false;
      throw error;
    }
  };
  const reapProcessGroup = (pid) => {
    if (process.platform === 'win32' || !Number.isInteger(pid) || pid < 1) return;
    if (!processGroupAlive(pid)) return;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const waitUntilGone = () => {
      const deadline = Date.now() + runtimePrebuildGroupShutdownTimeoutMs;
      while (processGroupAlive(pid) && Date.now() < deadline) {
        Atomics.wait(sleeper, 0, 0, 20);
      }
      return !processGroupAlive(pid);
    };
    process.kill(-pid, 'SIGTERM');
    if (waitUntilGone()) return;
    process.kill(-pid, 'SIGKILL');
    if (!waitUntilGone()) {
      throw new Error('Hanji self-host runtime prebuild process group did not exit.');
    }
  };
  const outputDir = mkdtempSync(join(temporaryRoot, 'hanji-self-host-worker-'));
  const cleanup = () => rmSync(outputDir, { recursive: true, force: true });
  try {
    const result = spawnSync(
      wranglerCommand,
      [...wranglerArgsPrefix, 'deploy', '--dry-run', '--outdir', outputDir, '--config', configPath],
      {
        cwd: runtimeAppRoot,
        env: {
          ...process.env,
          CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
          WRANGLER_SEND_METRICS: 'false',
        },
        stdio: 'inherit',
        detached: process.platform !== 'win32',
        timeout: runtimePrebuildTimeoutMs,
      },
    );
    reapProcessGroup(result.pid);
    if (result.error) {
      throw new Error('Hanji self-host runtime prebuild failed.', { cause: result.error });
    }
    if (result.status !== 0 || result.signal) {
      throw new Error(
        `Hanji self-host runtime prebuild exited with code=${String(result.status)} `
          + `signal=${String(result.signal)}.`,
      );
    }
    const entryPath = join(outputDir, 'index.js');
    const entry = lstatSync(entryPath);
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || entry.size < 1
      || entry.size > runtimePrebuildMaxBytes
    ) {
      throw new Error('Hanji self-host runtime prebuild produced an invalid worker entry.');
    }
    return { entryPath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function positivePort(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function validSecret(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.length >= 32 && value.length <= 1024;
}

function verifySelfHostAssets() {
  const source = readFileSync(appManifestPath);
  if (source.byteLength > 4 * 1024 * 1024) throw new Error('edgebase-app manifest is too large.');
  const manifest = JSON.parse(source.toString('utf8'));
  const selfHost = manifest?.selfHost;
  if (!selfHost || selfHost.schemaVersion !== 1) throw new Error('Invalid self-host manifest.');
  const expected = {
    gateway: '.edgebase/self-host/self-host-gateway.mjs',
    scheduleSupervisor: '.edgebase/self-host/self-host-schedule-supervisor.mjs',
    dockerEntrypoint: '.edgebase/self-host/self-host-docker-entrypoint.mjs',
    wranglerRuntime: '.edgebase/self-host/self-host-wrangler-runtime.mjs',
    proxyWorker: '.edgebase/self-host/self-host-proxy-worker.js',
  };
  const assets = {};
  for (const [name, expectedPath] of Object.entries(expected)) {
    const asset = selfHost[name];
    if (
      !asset
      || asset.path !== expectedPath
      || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
      || !Number.isSafeInteger(asset.bytes)
      || asset.bytes < 1
      || asset.bytes > 2 * 1024 * 1024
    ) {
      throw new Error(`Invalid self-host ${name} asset manifest.`);
    }
    const path = join(appRoot, asset.path);
    const fileStat = lstatSync(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== asset.bytes) {
      throw new Error(`Self-host ${name} asset does not match its file contract.`);
    }
    const content = readFileSync(path);
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (digest !== asset.digest) throw new Error(`Self-host ${name} asset digest mismatch.`);
    assets[name] = { path: asset.path, digest: asset.digest, bytes: asset.bytes };
  }
  const generation = `sha256:${createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    assets,
  })).digest('hex')}`;
  if (generation !== selfHost.generation) throw new Error('Self-host generation digest mismatch.');
  return { manifest, assets };
}

function isLoopbackBindHost(value) {
  return value === '127.0.0.1' || value === '::1';
}

function trustedProxyCidrs() {
  const configured = String(
    process.env.HANJI_TRUSTED_PROXY_CIDRS || process.env.EDGEBASE_TRUSTED_PROXY_CIDRS || '',
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  // The Docker default-route peer is not an identity boundary: direct traffic
  // forwarded through Docker can have the same socket peer as the NAS proxy.
  // Automatic trust is therefore limited to a gateway bound inside the host's
  // loopback namespace (the documented NAS host-network topology). Explicit
  // CIDRs remain an advanced operator-owned network boundary.
  const automatic = isLoopbackBindHost(host)
    ? ['127.0.0.0/8', '::1/128']
    : [];
  return [...new Set([...automatic, ...configured])];
}

function assertPrivateRegularFile(path, label, { privateFile = false } = {}) {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > 1024 * 1024) {
    throw new Error(`${label} must be a non-empty regular file no larger than 1 MiB.`);
  }
  if (privateFile && (file.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be readable or writable by group/other users.`);
  }
}

function validateTlsPair(certPath, keyPath) {
  assertPrivateRegularFile(certPath, 'HTTPS certificate');
  assertPrivateRegularFile(keyPath, 'HTTPS private key', { privateFile: true });
  const certificateKey = spawnSync(
    'openssl',
    ['x509', '-in', certPath, '-pubkey', '-noout'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 },
  );
  const privateKey = spawnSync(
    'openssl',
    ['pkey', '-in', keyPath, '-pubout'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 },
  );
  if (
    certificateKey.status !== 0
    || privateKey.status !== 0
    || certificateKey.stdout.trim() !== privateKey.stdout.trim()
  ) {
    throw new Error('HTTPS_CERT_PATH and HTTPS_KEY_PATH must contain one matching valid TLS pair.');
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

function resolveTlsMaterial() {
  if (protocol !== 'https') return undefined;
  const configuredCert = String(process.env.HTTPS_CERT_PATH || '').trim();
  const configuredKey = String(process.env.HTTPS_KEY_PATH || '').trim();
  if (Boolean(configuredCert) !== Boolean(configuredKey)) {
    throw new Error('HTTPS_CERT_PATH and HTTPS_KEY_PATH must be supplied together.');
  }
  if (configuredCert && configuredKey) return validateTlsPair(configuredCert, configuredKey);

  const tlsDir = join(secretDir, 'tls');
  const certPath = join(tlsDir, 'cert.pem');
  const keyPath = join(tlsDir, 'key.pem');
  if (existsSync(tlsDir)) {
    const directory = lstatSync(tlsDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('Generated TLS state must be a private directory, not a link or file.');
    }
    chmodSync(tlsDir, 0o700);
  }
  if (existsSync(certPath) || existsSync(keyPath)) {
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      throw new Error('Persisted self-signed TLS state is incomplete; restore the original /data backup.');
    }
    chmodSync(keyPath, 0o600);
    return validateTlsPair(certPath, keyPath);
  }

  const stagingDir = `${tlsDir}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const stagingCert = join(stagingDir, 'cert.pem');
  const stagingKey = join(stagingDir, 'key.pem');
  try {
    mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
    const generated = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '825',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
      '-keyout', stagingKey,
      '-out', stagingCert,
    ], { stdio: 'ignore' });
    if (generated.status !== 0) {
      throw new Error('Could not generate the persistent self-signed HTTPS certificate.');
    }
    chmodSync(stagingDir, 0o700);
    chmodSync(stagingKey, 0o600);
    chmodSync(stagingCert, 0o644);
    validateTlsPair(stagingCert, stagingKey);
    renameSync(stagingDir, tlsDir);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  console.log('Generated persistent self-signed HTTPS certificate under /data/.hanji/tls.');
  return validateTlsPair(certPath, keyPath);
}

function childTerminalError(terminal, phase) {
  if (terminal.kind === 'error') {
    return new Error(`Wrangler failed during ${phase}: ${terminal.error?.message || 'spawn error'}.`);
  }
  return new Error(
    `Wrangler exited during ${phase} (code ${terminal.code ?? 'null'}, `
    + `signal ${terminal.signal ?? 'none'}).`,
  );
}

function observeOwnedChild(child) {
  let current = null;
  let settle;
  const terminal = new Promise((resolvePromise) => {
    settle = (value) => {
      if (current) return;
      current = value;
      resolvePromise(value);
    };
  });
  child.once('error', (error) => settle({ kind: 'error', error }));
  child.once('exit', (code, signal) => settle({ kind: 'exit', code, signal }));
  if (child.exitCode !== null || child.signalCode !== null) {
    settle({ kind: 'exit', code: child.exitCode, signal: child.signalCode });
  }
  return {
    terminal,
    current: () => current,
    assertAlive(phase) {
      if (current || child.exitCode !== null || child.signalCode !== null) {
        throw childTerminalError(
          current || { kind: 'exit', code: child.exitCode, signal: child.signalCode },
          phase,
        );
      }
    },
    async race(promise, phase) {
      const result = await Promise.race([
        Promise.resolve(promise).then((value) => ({ kind: 'value', value })),
        terminal.then((value) => ({ kind: 'terminal', value })),
      ]);
      if (result.kind === 'terminal') throw childTerminalError(result.value, phase);
      this.assertAlive(phase);
      return result.value;
    },
  };
}

function signalOwnedChildGroup(child, signal) {
  if (!Number.isInteger(child.pid)) return;
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (
      error?.code !== 'ESRCH'
      && child.exitCode === null
      && child.signalCode === null
    ) {
      child.kill(signal);
    }
  }
}

function ownedChildGroupAlive(child) {
  if (!Number.isInteger(child.pid)) return false;
  if (process.platform === 'win32') {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForOwnedChildGroupExit(child, deadlineAt) {
  while (ownedChildGroupAlive(child)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Wrangler process group exceeded the shared shutdown deadline.');
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, Math.min(25, remainingMs));
    });
  }
}

async function settleWithin(promise, deadlineAt, label) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error(`${label} exceeded the shared shutdown deadline.`);
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded the shared shutdown deadline.`)),
          remainingMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForOwnedRuntime(origin, controlSecret, child, startupDeadlineAt) {
  while (Date.now() < startupDeadlineAt) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited before authenticated readiness (${child.exitCode}).`);
    }
    try {
      // Once Wrangler accepts this same-key readiness request, keep it
      // single-flight for the remaining bounded startup window. A client-side
      // retry can otherwise leave the already accepted server work running.
      const readinessTimeoutMs = Math.max(1, startupDeadlineAt - Date.now());
      const response = await fetch(`${origin}${controlRoot}/ready`, {
        headers: { 'x-edgebase-self-host-control': controlSecret },
        signal: AbortSignal.timeout(readinessTimeoutMs),
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload?.outcome === 'ok' && payload?.runtime === 'edgebase-self-host') return;
      }
    } catch {
      // Wrangler may still be compiling or opening persisted state.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    `Timed out waiting for authenticated internal Wrangler readiness within `
    + `${startupTimeoutMs} ms (HANJI_STARTUP_TIMEOUT_MS).`,
  );
}

async function productHealthReady(origin, timeoutMs) {
  try {
    const response = await fetch(`${origin}/api/functions/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function verifyAndCommitPersistenceFormat(
  child,
  runtimeOrigin,
  persistenceState,
  startupDeadlineAt,
) {
  while (Date.now() < startupDeadlineAt && child.exitCode === null) {
    const remainingMs = startupDeadlineAt - Date.now();
    if (await productHealthReady(runtimeOrigin, Math.min(remainingMs, 55_000))) {
      await applyPersistenceUpgrade(persistenceState);
      const marker = commitPersistenceFormat(persistenceState, {
        buildSha: process.env.HANJI_BUILD_SHA,
        imageVersion: process.env.HANJI_IMAGE_VERSION,
      });
      const path = persistenceState.steps.map((step) => step.version).join(' -> ');
      console.log(
        `Hanji persistence format ${marker.formatVersion} verified`
        + `${path ? ` after migration through ${path}` : ''}.`,
      );
      return;
    }
    const retryDelayMs = Math.min(1_000, startupDeadlineAt - Date.now());
    if (retryDelayMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
    }
  }
  throw new Error(
    `Hanji product health did not become ready within ${startupTimeoutMs} ms `
    + '(HANJI_STARTUP_TIMEOUT_MS); persistence format was not advanced.',
  );
}

if (port === internalPort) throw new Error('PORT and EDGEBASE_INTERNAL_PORT must differ.');
if (protocol !== 'http' && protocol !== 'https') {
  throw new Error('LOCAL_PROTOCOL must be http or https.');
}
if (!Number.isInteger(runtimeUid) || runtimeUid < 1
    || !Number.isInteger(runtimeGid) || runtimeGid < 1) {
  throw new Error('EDGEBASE_UID and EDGEBASE_GID must be positive integers.');
}
if (!Number.isInteger(minimumFreeKilobytes) || minimumFreeKilobytes < 0) {
  throw new Error('HANJI_DOCKER_MIN_FREE_KB must be a non-negative integer.');
}

// Verify one coherent generated runtime generation before touching /data or
// binding any port. The supervisor repeats this validation on every pass.
const { assets: selfHostAssets } = verifySelfHostAssets();

// Docker bind mounts replace the image's prepared /data directory. Start as
// root only to probe the dedicated mount as the fixed runtime identity. Host
// ownership and Synology ACL policy remain an explicit operator boundary.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  mkdirSync(persistDir, { recursive: true, mode: 0o700 });
  assertRuntimeDataDirectoryAccess({
    directory: persistDir,
    uid: runtimeUid,
    gid: runtimeGid,
  });
  process.setgid(runtimeGid);
  process.setuid(runtimeUid);
}

// Generated runtime code is never executed with the temporary root identity
// used solely to prepare the dedicated persistence mount.
const gatewayModule = await import(
  pathToFileURL(join(appRoot, selfHostAssets.gateway.path)).href
);
const supervisorModule = await import(
  pathToFileURL(join(appRoot, selfHostAssets.scheduleSupervisor.path)).href
);
const wranglerRuntimeModule = await import(
  pathToFileURL(join(appRoot, selfHostAssets.wranglerRuntime.path)).href
);
const appManifest = await supervisorModule.readSelfHostAppManifest(appManifestPath);
const runtimeAuthority = Object.freeze({
  generation: appManifest.generation,
  scheduleDigest: appManifest.schedules.digest,
});

// Fail before writing runtime state so a nearly full Docker VM cannot strand
// SQLite midway through an import.
const persistenceFilesystem = statfsSync(persistDir);
const availableKilobytes = Math.floor(
  (Number(persistenceFilesystem.bavail) * Number(persistenceFilesystem.bsize)) / 1024,
);
if (availableKilobytes < minimumFreeKilobytes) {
  throw new Error(
    `Docker persistence storage is too full (${availableKilobytes} KiB free; require `
    + `${minimumFreeKilobytes} KiB). Free Docker disk space and restart. The /data volume was kept.`,
  );
}
const filesystemAdmissionController = gatewayModule.createFilesystemCapacityAdmissionController({
  path: persistDir,
  minimumFreeBytes: minimumFreeKilobytes * 1024,
});

mkdirSync(secretDir, { recursive: true, mode: 0o700 });
chmodSync(secretDir, 0o700);
const persistenceState = inspectPersistenceFormat(secretDir);
let persisted = {};
if (existsSync(secretFile)) {
  persisted = parsePersistedRuntimeSecrets(readFileSync(secretFile, 'utf8'), secretFile);
}

delete persisted.HANJI_SETUP_TOKEN;
delete process.env.HANJI_SETUP_TOKEN;
for (const name of secretNames) {
  const explicit = process.env[name];
  const saved = persisted[name];
  if (explicit && !validSecret(explicit)) {
    throw new Error(`${name} does not meet the container secret requirements.`);
  }
  if (saved !== undefined && !validSecret(saved)) {
    throw new Error(`Persisted ${name} is invalid; restore the original /data backup.`);
  }
  if (explicit && saved && explicit !== saved) {
    throw new Error(`${name} differs from the value persisted in /data; use an explicit rotation workflow.`);
  }
  persisted[name] = saved || explicit || randomBytes(32).toString('hex');
  process.env[name] = persisted[name];
}

const temporarySecretFile = `${secretFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
try {
  writeFileSync(temporarySecretFile, `${JSON.stringify(persisted, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  chmodSync(temporarySecretFile, 0o600);
  renameSync(temporarySecretFile, secretFile);
} finally {
  rmSync(temporarySecretFile, { force: true });
}
chmodSync(secretFile, 0o600);
const tls = resolveTlsMaterial();

mkdirSync('/home/edgebase/.config', { recursive: true });
if (generatedConfigSource !== null) {
  mkdirSync(dirname(generatedConfigPath), { recursive: true });
  writeFileSync(generatedConfigPath, generatedConfigSource, 'utf8');
}

// The gateway is the sole external admission boundary. The Worker can trust
// its normalized forwarding headers because Wrangler itself is loopback-only.
process.env.HANJI_BROWSER_SETUP ||= 'true';
process.env.HANJI_TRUST_SELF_HOSTED_PROXY ||= 'true';
const controlSecret = randomBytes(32).toString('hex');
const gatewaySecret = randomBytes(32).toString('hex');
process.env.EDGEBASE_RUNTIME_MODE = 'self-hosted';
process.env.EDGEBASE_SELF_HOST_CONTROL_SECRET = controlSecret;
process.env.EDGEBASE_SELF_HOST_GATEWAY_SECRET = gatewaySecret;
process.env.EDGEBASE_SELF_HOST_APP_GENERATION = runtimeAuthority.generation;
process.env.EDGEBASE_SELF_HOST_SCHEDULE_DIGEST = runtimeAuthority.scheduleDigest;

const configEnvAllowlist = new Set(
  String(process.env.EDGEBASE_CONFIG_ENV_ALLOWLIST || '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)),
);
for (const name of secretNames) configEnvAllowlist.add(name);
for (const name of Object.keys(process.env)) {
  if (name.startsWith('HANJI_')) configEnvAllowlist.add(name);
}
configEnvAllowlist.add('EDGEBASE_RUNTIME_MODE');
configEnvAllowlist.add('EDGEBASE_SELF_HOST_CONTROL_SECRET');
configEnvAllowlist.add('EDGEBASE_SELF_HOST_GATEWAY_SECRET');
configEnvAllowlist.add('EDGEBASE_SELF_HOST_APP_GENERATION');
configEnvAllowlist.add('EDGEBASE_SELF_HOST_SCHEDULE_DIGEST');
process.env.EDGEBASE_CONFIG_ENV_ALLOWLIST = [...configEnvAllowlist].sort().join(',');
delete process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV;

const devVarsPath = '/app/.dev.vars';
const temporaryDevVarsPath = `${devVarsPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
const devVarLines = ['# Auto-generated by the Hanji appliance entrypoint. Do not package or commit.'];
for (const name of [...configEnvAllowlist].sort()) {
  const value = process.env[name];
  if (typeof value !== 'string') continue;
  devVarLines.push(`${name}=${JSON.stringify(value).replace(/\$/g, '\\$')}`);
}
try {
  writeFileSync(temporaryDevVarsPath, `${devVarLines.join('\n')}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  chmodSync(temporaryDevVarsPath, 0o600);
  renameSync(temporaryDevVarsPath, devVarsPath);
  chmodSync(devVarsPath, 0o600);
} finally {
  rmSync(temporaryDevVarsPath, { force: true });
}

const wranglerTool = wranglerRuntimeModule.prepareSelfHostWranglerTool({
  baseDir: appRoot,
  cacheRoot: join(process.env.TMPDIR || '/tmp', 'edgebase-self-host-wrangler-runtime'),
  proxyWorkerPath: join(appRoot, selfHostAssets.proxyWorker.path),
});
const runtimeBundle = prebuildSelfHostRuntime({
  wranglerCommand: wranglerTool.command,
  wranglerArgsPrefix: wranglerTool.argsPrefix,
});
process.once('exit', runtimeBundle.cleanup);
const wranglerArgs = [
  'dev',
  runtimeBundle.entryPath,
  '--no-bundle',
  '--config', wranglerConfig,
  '--port', String(internalPort),
  '--ip', '127.0.0.1',
  '--persist-to', persistDir,
  '--show-interactive-dev-session=false',
  '--var', 'EDGEBASE_RUNTIME_MODE:self-hosted',
  '--var', `EDGEBASE_SELF_HOST_CONTROL_SECRET:${controlSecret}`,
  '--var', `EDGEBASE_SELF_HOST_GATEWAY_SECRET:${gatewaySecret}`,
  '--var', `EDGEBASE_SELF_HOST_APP_GENERATION:${runtimeAuthority.generation}`,
  '--var', `EDGEBASE_SELF_HOST_SCHEDULE_DIGEST:${runtimeAuthority.scheduleDigest}`,
];
const child = spawn(wranglerTool.command, [...wranglerTool.argsPrefix, ...wranglerArgs], {
  cwd: appRoot,
  env: process.env,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});
// Observe every terminal child state immediately after spawn. Node does not
// replay an `exit` event to a listener installed after startup admission.
const childLifecycle = observeOwnedChild(child);
const runtimeOrigin = `http://127.0.0.1:${internalPort}`;
let gateway;
let supervisor;
let startupFailed = false;
let stopPromise;
let requestedStopSignal;

function stop(signal = 'SIGTERM') {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    const deadlineAt = Date.now() + shutdownTimeoutMs;
    try {
      await settleWithin(Promise.resolve(gateway?.stopAdmission()), deadlineAt, 'gateway admission stop');
    } catch (error) {
      console.error('Hanji gateway admission stop failed.', error);
    }
    if (supervisor) {
      try {
        const timeoutMs = Math.max(1, deadlineAt - Date.now());
        await settleWithin(
          supervisor.stop({ timeoutMs }),
          deadlineAt,
          'schedule supervisor stop',
        );
      } catch (error) {
        console.error('Hanji schedule supervisor stop failed.', error);
      }
    }
    if (gateway) {
      try {
        const drainTimeoutMs = Math.max(0, deadlineAt - Date.now());
        await settleWithin(
          gateway.stop({ drainTimeoutMs }),
          deadlineAt,
          'self-host gateway stop',
        );
      } catch (error) {
        console.error('Hanji self-host gateway stop failed.', error);
      }
    }

    if (!childLifecycle.current() || ownedChildGroupAlive(child)) {
      signalOwnedChildGroup(child, signal);
      const gracefulDeadline = Math.max(Date.now(), deadlineAt - 250);
      try {
        await settleWithin(
          waitForOwnedChildGroupExit(child, gracefulDeadline),
          gracefulDeadline,
          'Wrangler process-group stop',
        );
      } catch (error) {
        signalOwnedChildGroup(child, 'SIGKILL');
        try {
          await settleWithin(
            waitForOwnedChildGroupExit(child, deadlineAt),
            deadlineAt,
            'Wrangler process-group kill',
          );
        } catch (killError) {
          console.error('Hanji Wrangler process-group kill did not settle before deadline.', {
            gracefulError: error,
            killError,
          });
        }
      }
    }
    if (!ownedChildGroupAlive(child)) runtimeBundle.cleanup();
  })();
  return stopPromise;
}

function currentSchedulerStatus() {
  return supervisor?.getStatus?.() ?? {
    state: 'blocked',
    structuralReady: false,
    itemFailureCount: 0,
    lastAttemptAt: null,
    lastSuccessfulPassAt: null,
    lastError: 'schedule supervisor has not completed startup admission',
  };
}

function gatewayAdmissionGuard() {
  if (childLifecycle.current()) return false;
  const status = currentSchedulerStatus();
  return status.structuralReady === true
    && status.state !== 'blocked'
    && status.state !== 'stopped';
}

// Install signal ownership before any startup await. Otherwise a container
// stop during readiness, persistence admission, the first schedule pass, or
// gateway bind can take Node's default signal path and orphan the detached
// Wrangler process group.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    requestedStopSignal ||= signal;
    void stop(signal).finally(() => {
      if (!startupFailed) process.exitCode = 0;
    });
  });
}

void childLifecycle.terminal.then(async (terminal) => {
  if (stopPromise) return;
  startupFailed = true;
  console.error(childTerminalError(terminal, 'runtime service'));
  process.exitCode = 1;
  await stop('SIGTERM');
});

const startupDeadlineAt = Date.now() + startupTimeoutMs;
try {
  await childLifecycle.race(
    waitForOwnedRuntime(runtimeOrigin, controlSecret, child, startupDeadlineAt),
    'authenticated runtime readiness',
  );
  await childLifecycle.race(
    supervisorModule.readSelfHostScheduleState(scheduleStateFile),
    'schedule-state validation',
  );
  await childLifecycle.race(
    verifyAndCommitPersistenceFormat(
      child,
      runtimeOrigin,
      persistenceState,
      startupDeadlineAt,
    ),
    'product health and persistence admission',
  );

  const scheduleOutcomeLogger = supervisorModule.createSelfHostScheduleOutcomeLogger({
    prefix: 'Hanji',
    writeInfo: (line) => console.log(line),
    writeError: (line) => console.error(line),
  });
  supervisor = supervisorModule.createSelfHostScheduleSupervisor({
    manifestPath: appManifestPath,
    statePath: scheduleStateFile,
    runtimeOrigin,
    controlSecret,
    onReport(report) {
      scheduleOutcomeLogger.report(report);
    },
    onError(error) {
      console.error('Hanji schedule supervisor degraded.', error);
    },
  });
  const initialReport = await childLifecycle.race(
    supervisor.runOnce(),
    'initial schedule pass',
  );
  scheduleOutcomeLogger.report(initialReport, { initial: true });
  const initialStatus = currentSchedulerStatus();
  if (!initialStatus.structuralReady || initialStatus.state === 'blocked') {
    throw new Error(`Schedule supervisor did not pass structural startup admission: ${JSON.stringify(initialStatus)}`);
  }

  gateway = await childLifecycle.race(
    gatewayModule.startSelfHostGateway({
      host,
      port,
      upstreamPort: internalPort,
      protocol,
      ...(tls ? { tls } : {}),
      trustedProxyCidrs: trustedProxyCidrs(),
      workerTrustSecret: gatewaySecret,
      storageAdmissionController: filesystemAdmissionController,
      healthProvider: currentSchedulerStatus,
      admissionGuard: gatewayAdmissionGuard,
    }),
    'external gateway bind',
  );
  childLifecycle.assertAlive('external gateway admission');
  supervisor.start();
  console.log(
    `Hanji self-host ready external=${protocol}://${host}:${port} `
    + `internal=${runtimeOrigin} generation=${appManifest.generation}`,
  );
} catch (error) {
  if (requestedStopSignal) {
    await stop(requestedStopSignal);
    process.exitCode = 0;
  } else {
    startupFailed = true;
    console.error('Hanji self-host startup failed.', error);
    await stop('SIGTERM');
    process.exitCode = 1;
  }
}
