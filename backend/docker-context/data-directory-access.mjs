import { spawnSync } from 'node:child_process';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_OUTPUT_BYTES = 4_096;
const PROBE_SOURCE = String.raw`
const {
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

const directory = process.argv[1];
const filename = process.argv[2];
const probePath = join(directory, filename);
let created = false;

try {
  readdirSync(directory);
  writeFileSync(probePath, 'hanji-data-access-probe', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  created = true;
  if (readFileSync(probePath, 'utf8') !== 'hanji-data-access-probe') {
    throw new Error('probe content mismatch');
  }
  unlinkSync(probePath);
  created = false;
} catch (error) {
  if (created) {
    try {
      unlinkSync(probePath);
    } catch {
      // Preserve the original access failure; the parent reports no host path.
    }
  }
  process.stderr.write(String(error?.code || 'DATA_ACCESS_FAILED'));
  process.exit(73);
}
`;

function positiveIdentity(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function safeProbeToken(value) {
  const token = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return token || String(process.pid);
}

function dataAccessError(directory, uid, gid) {
  return new Error(
    `Hanji cannot use ${directory} as runtime UID/GID ${uid}:${gid}. `
    + 'Prepare only the dedicated Hanji data directory so this identity can '
    + 'read, write, create, and delete through both POSIX permissions and any '
    + 'Synology ACL, then restart. Hanji did not change ownership or ACLs.',
  );
}

export function assertRuntimeDataDirectoryAccess({
  directory,
  uid,
  gid,
  nodeExecutable = process.execPath,
  probeToken = process.pid,
  spawnSyncImpl = spawnSync,
} = {}) {
  const normalizedDirectory = String(directory ?? '');
  if (!normalizedDirectory || normalizedDirectory.includes('\0')) {
    throw new Error('Hanji data directory must be a non-empty NUL-free path.');
  }
  const runtimeUid = positiveIdentity(uid, 'runtime UID');
  const runtimeGid = positiveIdentity(gid, 'runtime GID');
  const probeFilename = `.hanji-data-access-probe-${safeProbeToken(probeToken)}`;

  let result;
  try {
    result = spawnSyncImpl(
      nodeExecutable,
      ['-e', PROBE_SOURCE, normalizedDirectory, probeFilename],
      {
        uid: runtimeUid,
        gid: runtimeGid,
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_OUTPUT_BYTES,
      },
    );
  } catch {
    throw dataAccessError(normalizedDirectory, runtimeUid, runtimeGid);
  }

  if (result?.status !== 0 || result?.signal || result?.error) {
    throw dataAccessError(normalizedDirectory, runtimeUid, runtimeGid);
  }
}
