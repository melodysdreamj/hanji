import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const PERSISTENCE_FORMAT_FILE = 'persistence-format.json';
export const LEGACY_PERSISTENCE_FORMAT_VERSION = 1;
export const CURRENT_PERSISTENCE_FORMAT_VERSION = 2;
export const MIN_READABLE_PERSISTENCE_FORMAT_VERSION = 1;

const migrations = new Map([
  [
    2,
    {
      atomicity: 'metadata-only',
      description: 'Adopt the versioned Hanji appliance persistence envelope',
      // EdgeBase owns table DDL and records each table migration in its
      // internal _meta state. This first appliance migration performs no I/O:
      // it makes that existing durable schema state explicit at the whole-/data
      // compatibility boundary.
    },
  ],
]);

const METADATA_ONLY_ATOMICITY = 'metadata-only';
const EDGEBASE_TRANSACTION_ATOMICITY = 'edgebase-transaction';

function planMigrationStep(version, migration, runEdgeBaseTransaction) {
  const label = `Hanji persistence migration ${version - 1} -> ${version}`;
  if (!migration || typeof migration !== 'object' || Array.isArray(migration)) {
    throw new Error(`${label} is not registered.`);
  }
  if (
    migration.atomicity !== METADATA_ONLY_ATOMICITY
    && migration.atomicity !== EDGEBASE_TRANSACTION_ATOMICITY
  ) {
    throw new Error(
      `${label} must declare atomicity as metadata-only or edgebase-transaction.`,
    );
  }
  if (migration.atomicity === METADATA_ONLY_ATOMICITY) {
    if (Object.hasOwn(migration, 'apply')) {
      throw new Error(`${label} is metadata-only and must not register an apply callback.`);
    }
    return Object.freeze({
      atomicity: METADATA_ONLY_ATOMICITY,
      description: migration.description,
      version,
    });
  }
  if (typeof migration.apply !== 'function') {
    throw new Error(`${label} must register one EdgeBase transaction callback.`);
  }
  if (typeof runEdgeBaseTransaction !== 'function') {
    throw new Error(`${label} requires an EdgeBase transaction runner before startup.`);
  }
  const applyTransaction = migration.apply;
  return Object.freeze({
    atomicity: EDGEBASE_TRANSACTION_ATOMICITY,
    description: migration.description,
    version,
    apply: () => runEdgeBaseTransaction((transaction) => applyTransaction(transaction)),
  });
}

function parseMarker(raw, markerPath) {
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid Hanji persistence marker: ${markerPath}. Restore a known-good /data backup.`,
    );
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new Error(
      `Invalid Hanji persistence marker: ${markerPath}. Restore a known-good /data backup.`,
    );
  }
  if (!Number.isInteger(marker.formatVersion) || marker.formatVersion < 1) {
    throw new Error(
      `Invalid Hanji persistence format version in ${markerPath}. Restore a known-good /data backup.`,
    );
  }
  return marker;
}

export function parsePersistedRuntimeSecrets(raw, secretFile) {
  let persisted;
  try {
    persisted = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid Hanji runtime secret file: ${secretFile}. Restore a known-good /data backup.`,
    );
  }
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
    throw new Error(
      `Invalid Hanji runtime secret file: ${secretFile}. Restore a known-good /data backup.`,
    );
  }
  return persisted;
}

export function planPersistenceUpgrade(storedVersion, {
  currentVersion = CURRENT_PERSISTENCE_FORMAT_VERSION,
  minimumVersion = MIN_READABLE_PERSISTENCE_FORMAT_VERSION,
  migrationRegistry = migrations,
  runEdgeBaseTransaction,
} = {}) {
  if (!Number.isInteger(storedVersion) || storedVersion < 1) {
    throw new Error(`Hanji persistence format version must be a positive integer; got ${storedVersion}.`);
  }
  if (storedVersion > currentVersion) {
    throw new Error(
      `This /data volume uses Hanji persistence format ${storedVersion}, but this image supports ` +
      `through ${currentVersion}. Start a compatible newer image or restore the backup made before upgrade.`,
    );
  }
  if (storedVersion < minimumVersion) {
    throw new Error(
      `This /data volume uses Hanji persistence format ${storedVersion}, older than the minimum ` +
      `readable format ${minimumVersion}. Restore it with an intermediate Hanji image first.`,
    );
  }

  const steps = [];
  for (let version = storedVersion + 1; version <= currentVersion; version += 1) {
    const migration = migrationRegistry.get(version);
    steps.push(planMigrationStep(version, migration, runEdgeBaseTransaction));
  }
  return steps;
}

export function inspectPersistenceFormat(secretDir) {
  const markerPath = join(secretDir, PERSISTENCE_FORMAT_FILE);
  const legacy = !existsSync(markerPath);
  const marker = legacy ? null : parseMarker(readFileSync(markerPath, 'utf8'), markerPath);
  const storedVersion = marker?.formatVersion ?? LEGACY_PERSISTENCE_FORMAT_VERSION;
  return {
    legacy,
    marker,
    markerPath,
    steps: planPersistenceUpgrade(storedVersion),
    storedVersion,
  };
}

export function applyPersistenceUpgrade(state) {
  let pending;
  for (const step of state.steps) {
    if (step.atomicity === METADATA_ONLY_ATOMICITY) continue;
    if (
      step.atomicity !== EDGEBASE_TRANSACTION_ATOMICITY
      || typeof step.apply !== 'function'
    ) {
      throw new Error(`Hanji persistence migration ${step.version} was not atomically admitted.`);
    }
    const apply = () => step.apply();
    if (pending) {
      pending = pending.then(apply);
      continue;
    }
    const result = apply();
    if (result && typeof result.then === 'function') pending = Promise.resolve(result);
  }
  return pending;
}

export function commitPersistenceFormat(state, {
  buildSha = 'unknown',
  imageVersion = 'unknown',
  now = () => new Date(),
} = {}) {
  const marker = {
    formatVersion: CURRENT_PERSISTENCE_FORMAT_VERSION,
    imageVersion: String(imageVersion || 'unknown'),
    buildSha: String(buildSha || 'unknown'),
    verifiedAt: now().toISOString(),
  };
  const temporaryPath = `${state.markerPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, state.markerPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  chmodSync(state.markerPath, 0o600);
  return marker;
}
