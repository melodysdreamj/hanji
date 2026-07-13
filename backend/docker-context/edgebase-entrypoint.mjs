import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const persistDir = process.env.PERSIST_DIR || '/data';
const host = process.env.HOST || '0.0.0.0';
const port = process.env.PORT || '8787';
const wranglerConfig = process.env.WRANGLER_CONFIG || 'wrangler.toml';
const protocol = process.env.LOCAL_PROTOCOL || 'https';
const runtimeUid = Number(process.env.EDGEBASE_UID || '10001');
const runtimeGid = Number(process.env.EDGEBASE_GID || '10001');
const secretDir = join(persistDir, '.hanji');
const secretFile = join(secretDir, 'runtime-secrets.json');
const generatedConfigPath = '/app/.edgebase/runtime/server/src/generated-config.ts';
const secretNames = [
  'JWT_USER_SECRET',
  'JWT_ADMIN_SECRET',
  'SERVICE_KEY',
  'HANJI_NOTION_IMPORT_SECRET',
  'HANJI_MCP_OAUTH_SECRET',
  'HANJI_SETUP_TOKEN',
];

function validSecret(name, value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (name === 'HANJI_SETUP_TOKEN') return value.length >= 24 && value.length <= 256;
  return value.length >= 32 && value.length <= 1024;
}

if (!Number.isInteger(runtimeUid) || runtimeUid < 1 ||
    !Number.isInteger(runtimeGid) || runtimeGid < 1) {
  throw new Error('EDGEBASE_UID and EDGEBASE_GID must be positive integers.');
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

mkdirSync(secretDir, { recursive: true, mode: 0o700 });
chmodSync(secretDir, 0o700);
let persisted = {};
if (existsSync(secretFile)) {
  persisted = JSON.parse(readFileSync(secretFile, 'utf8'));
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
    throw new Error(`Invalid Hanji runtime secret file: ${secretFile}`);
  }
}

for (const name of secretNames) {
  const explicit = process.env[name];
  const saved = persisted[name];
  if (explicit && !validSecret(name, explicit)) {
    throw new Error(`${name} does not meet the container secret requirements.`);
  }
  if (saved !== undefined && !validSecret(name, saved)) {
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

// A bundled .dev.vars makes Wrangler ignore the container process environment.
rmSync('/app/.dev.vars', { force: true });
process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV ||= 'true';

if (!process.env.HANJI_MASTER_EMAIL && !process.env.HANJI_MASTER_PASSWORD) {
  console.log('');
  console.log('Hanji first-run setup code (used only while this instance has no administrator):');
  console.log(process.env.HANJI_SETUP_TOKEN);
  console.log('');
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
