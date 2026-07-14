import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const persistDir = process.env.PERSIST_DIR || '/data';
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || '8787';
const wranglerConfig = process.env.WRANGLER_CONFIG || 'wrangler.toml';
const protocol = process.env.LOCAL_PROTOCOL || 'http';
const runtimeUid = Number(process.env.EDGEBASE_UID || '10001');
const runtimeGid = Number(process.env.EDGEBASE_GID || '10001');
const minimumFreeKilobytes = Number(process.env.HANJI_DOCKER_MIN_FREE_KB || '524288');
const secretDir = join(persistDir, '.hanji');
const secretFile = join(secretDir, 'runtime-secrets.json');
const generatedConfigPath = '/app/.edgebase/runtime/server/src/generated-config.ts';
const secretNames = [
  'JWT_USER_SECRET',
  'JWT_ADMIN_SECRET',
  'SERVICE_KEY',
  'HANJI_NOTION_IMPORT_SECRET',
  'HANJI_MCP_OAUTH_SECRET',
];

function validSecret(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.length >= 32 && value.length <= 1024;
}

if (!Number.isInteger(runtimeUid) || runtimeUid < 1 ||
    !Number.isInteger(runtimeGid) || runtimeGid < 1) {
  throw new Error('EDGEBASE_UID and EDGEBASE_GID must be positive integers.');
}
if (!Number.isInteger(minimumFreeKilobytes) || minimumFreeKilobytes < 0) {
  throw new Error('HANJI_DOCKER_MIN_FREE_KB must be a non-negative integer.');
}

// Docker bind mounts replace the image's prepared /data directory. Start as
// root only to make that dedicated mount writable by the fixed runtime user;
// avoid recursive ownership changes for arbitrary PERSIST_DIR overrides.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  mkdirSync(persistDir, { recursive: true, mode: 0o700 });
  const owner = statSync(persistDir);
  if (persistDir === '/data' && (owner.uid !== runtimeUid || owner.gid !== runtimeGid)) {
    const result = spawnSync('chown', ['-R', `${runtimeUid}:${runtimeGid}`, persistDir], {
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error(`Could not prepare ${persistDir} ownership.`);
  }
  process.setgid(runtimeGid);
  process.setuid(runtimeUid);
}

// A registry-pulled image starts this entrypoint directly, without the helper
// launcher that performs the same guard. Fail before writing runtime state so
// a nearly full Docker VM cannot strand SQLite midway through an import.
const persistenceFilesystem = statfsSync(persistDir);
const availableKilobytes = Math.floor(
  (Number(persistenceFilesystem.bavail) * Number(persistenceFilesystem.bsize)) / 1024,
);
if (availableKilobytes < minimumFreeKilobytes) {
  throw new Error(
    `Docker persistence storage is too full (${availableKilobytes} KiB free; require ` +
    `${minimumFreeKilobytes} KiB). Free Docker disk space and restart. The /data volume was kept.`,
  );
}

mkdirSync(secretDir, { recursive: true, mode: 0o700 });
chmodSync(secretDir, 0o700);
let persisted = {};
if (existsSync(secretFile)) {
  persisted = JSON.parse(readFileSync(secretFile, 'utf8'));
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
    throw new Error(`Invalid Hanji runtime secret file: ${secretFile}`);
  }
}

// Older alpha volumes may contain the retired terminal-copy setup token. It is
// no longer an authority and must not remain among the appliance secrets.
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
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  chmodSync(temporarySecretFile, 0o600);
  renameSync(temporarySecretFile, secretFile);
} finally {
  rmSync(temporarySecretFile, { force: true });
}
chmodSync(secretFile, 0o600);

mkdirSync('/home/edgebase/.config', { recursive: true });
if (process.env.EDGEBASE_CONFIG) {
  mkdirSync(dirname(generatedConfigPath), { recursive: true });
  writeFileSync(
    generatedConfigPath,
    `const config = ${process.env.EDGEBASE_CONFIG};\n\nexport default config;\n`,
    'utf8',
  );
}

// The image, not the NAS operator, enables the wiki-style browser installer.
// This is capability state rather than a secret: the durable single-winner
// claim closes the installer permanently after the first administrator.
process.env.HANJI_BROWSER_SETUP ||= 'true';
process.env.HANJI_TRUST_SELF_HOSTED_PROXY ||= 'true';

// Wrangler treats .dev.vars as the sole Worker environment source. Keep that
// boundary narrow: the image-managed runtime secrets plus operator-supplied
// HANJI_* settings are the only container values that may cross it. This mirrors
// EdgeBase dev's explicit allowlist and mode-0600 atomic materialization.
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
process.env.EDGEBASE_CONFIG_ENV_ALLOWLIST = [...configEnvAllowlist].sort().join(',');
delete process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV;

const devVarsPath = '/app/.dev.vars';
const temporaryDevVarsPath = `${devVarsPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
const devVarLines = [
  '# Auto-generated by the Hanji appliance entrypoint. Do not package or commit.',
];
for (const name of [...configEnvAllowlist].sort()) {
  const value = process.env[name];
  if (typeof value !== 'string') continue;
  const encoded = JSON.stringify(value).replace(/\$/g, '\\$');
  devVarLines.push(`${name}=${encoded}`);
}
try {
  writeFileSync(temporaryDevVarsPath, `${devVarLines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  chmodSync(temporaryDevVarsPath, 0o600);
  renameSync(temporaryDevVarsPath, devVarsPath);
  chmodSync(devVarsPath, 0o600);
} finally {
  rmSync(temporaryDevVarsPath, { force: true });
}

const args = [
  'dev',
  '--config', wranglerConfig,
  '--port', port,
  '--ip', host,
  '--persist-to', persistDir,
  '--show-interactive-dev-session=false',
];
if (protocol === 'https') {
  args.push('--local-protocol', 'https');
  if (process.env.HTTPS_CERT_PATH && process.env.HTTPS_KEY_PATH) {
    args.push('--https-cert-path', process.env.HTTPS_CERT_PATH);
    args.push('--https-key-path', process.env.HTTPS_KEY_PATH);
  }
} else if (protocol !== 'http') {
  throw new Error('LOCAL_PROTOCOL must be http or https.');
}

const child = spawn('wrangler', args, { cwd: '/app', env: process.env, stdio: 'inherit' });
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
