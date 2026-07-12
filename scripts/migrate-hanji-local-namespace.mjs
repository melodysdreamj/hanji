#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGACY_PREFIX = 'NOTIONLIKE_';
const CANONICAL_PREFIX = 'HANJI_';
const LEGACY_BACKEND_COMPONENT_PREFIX = 'notionlike-backend-';
const CANONICAL_BACKEND_COMPONENT_PREFIX = 'hanji-backend-';
const LEGACY_DEV_TARGET_PREFIX = 'notionlike-';
const CANONICAL_DEV_TARGET_PREFIX = 'hanji-';
const LEGACY_PRIMARY_NAME_PATTERN = new RegExp(['notion', '[._\\s-]*', 'like'].join(''), 'gi');
const LEGACY_SECONDARY_NAME_PATTERN = new RegExp(['ink', '[._\\s-]*', 'line'].join(''), 'gi');
const LEGACY_PRIMARY_KOREAN_NAME_PATTERN = /노션[._\s-]*라이크/g;
const LEGACY_SECONDARY_KOREAN_NAME_PATTERN = /잉크[._\s-]*라인/g;
const RUNTIME_COMMAND_PATTERN = /(?:\bedgebase\s+dev\b|\bwrangler\b.*\bdev\b|\bworkerd\b|\bminiflare\b)/i;
const RETIRED_AUTOLOGIN_NAMES = new Set([
  `${LEGACY_PREFIX}MASTER_DEV_AUTOLOGIN`,
  `${CANONICAL_PREFIX}MASTER_DEV_AUTOLOGIN`,
]);
const BACKUP_SCOPE = 'backend/.edgebase, root .edgebase, and every target ignored env file';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Treat a dangling symbolic link as an occupied path and fail closed. */
function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Rewrite one ignored env file without exposing any values.
 *
 * @param {string} source
 */
export function migrateEnvText(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = source.endsWith('\n');
  const lines = source.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const activeAssignments = new Map();
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/i);
    if (!match) continue;
    const indexes = activeAssignments.get(match[1]) ?? [];
    indexes.push(index);
    activeAssignments.set(match[1], indexes);
  }

  const collisions = [];
  for (const [name, indexes] of activeAssignments) {
    if (!name.startsWith(LEGACY_PREFIX) || RETIRED_AUTOLOGIN_NAMES.has(name)) continue;
    const canonicalName = `${CANONICAL_PREFIX}${name.slice(LEGACY_PREFIX.length)}`;
    if (indexes.length > 1 || activeAssignments.has(canonicalName)) {
      collisions.push(canonicalName);
    }
  }
  if (collisions.length) {
    throw new Error(
      `Environment migration would create duplicate canonical assignments: ${Array.from(new Set(collisions)).sort().join(', ')}`,
    );
  }

  let renamedAssignments = 0;
  let removedRetiredAssignments = 0;
  const migrated = [];
  for (const line of lines) {
    const assignment = line.match(/^(\s*(?:export\s+)?)([A-Z_][A-Z0-9_]*)(\s*=.*)$/i);
    const commented = line.match(/^(\s*#\s*(?:export\s+)?)([A-Z_][A-Z0-9_]*)(\s*=.*)$/i);
    const match = assignment ?? commented;
    if (!match) {
      migrated.push(line);
      continue;
    }

    const [, leading, name, remainder] = match;
    if (RETIRED_AUTOLOGIN_NAMES.has(name)) {
      removedRetiredAssignments += 1;
      continue;
    }
    if (!name.startsWith(LEGACY_PREFIX)) {
      migrated.push(line);
      continue;
    }

    migrated.push(`${leading}${CANONICAL_PREFIX}${name.slice(LEGACY_PREFIX.length)}${remainder}`);
    renamedAssignments += 1;
  }

  const text = `${migrated.join(newline)}${hadFinalNewline ? newline : ''}`;
  return {
    text,
    changed: text !== source,
    renamedAssignments,
    removedRetiredAssignments,
  };
}

/** Return only assignment names, never values, for pre-Hanji active env keys. */
export function legacyHanjiEnvAssignmentNames(source) {
  const names = new Set();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(NOTIONLIKE_[A-Z0-9_]*)\s*=/i);
    if (match) names.add(match[1].toUpperCase());
  }
  return [...names].sort();
}

/** Return only active pre-Hanji process/environment names, never their values. */
export function legacyHanjiEnvironmentNames(env) {
  return Object.keys(env ?? {})
    .filter((name) => name.startsWith(LEGACY_PREFIX))
    .sort();
}

/**
 * Normalize an in-memory environment for one release-preflight evaluation.
 * Canonical values always win; this does not mutate the caller's object.
 *
 * @param {Record<string, unknown>} env
 */
export function canonicalizeHanjiEnvironment(env) {
  const normalized = { ...env };
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_PREFIX)) continue;
    const canonicalName = `${CANONICAL_PREFIX}${name.slice(LEGACY_PREFIX.length)}`;
    if (!Object.hasOwn(normalized, canonicalName)) normalized[canonicalName] = value;
  }
  return normalized;
}

/** @param {string} name @param {{ devTarget?: boolean }} [options] */
export function migratedPathComponent(name, { devTarget = false } = {}) {
  let migrated = name;
  if (name.startsWith(LEGACY_BACKEND_COMPONENT_PREFIX)) {
    migrated = `${CANONICAL_BACKEND_COMPONENT_PREFIX}${name.slice(LEGACY_BACKEND_COMPONENT_PREFIX.length)}`;
  }
  if (devTarget && migrated.startsWith(LEGACY_DEV_TARGET_PREFIX)) {
    migrated = `${CANONICAL_DEV_TARGET_PREFIX}${migrated.slice(LEGACY_DEV_TARGET_PREFIX.length)}`;
  }
  return migrated
    .replace(LEGACY_PRIMARY_NAME_PATTERN, 'hanji')
    .replace(LEGACY_SECONDARY_NAME_PATTERN, 'hanji')
    .replace(LEGACY_PRIMARY_KOREAN_NAME_PATTERN, '한지')
    .replace(LEGACY_SECONDARY_KOREAN_NAME_PATTERN, '한지');
}

/** @param {string} root */
export function collectPathRenamePlan(root) {
  const backendEdgebaseDir = join(root, 'backend', '.edgebase');
  const localEdgebaseDir = join(root, '.edgebase');
  const devTargetsDir = join(backendEdgebaseDir, 'dev');

  const plan = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(source);
      const destinationName = migratedPathComponent(entry.name, {
        devTarget: directory === devTargetsDir,
      });
      if (destinationName !== entry.name) {
        plan.push({ source, destination: join(directory, destinationName) });
      }
    }
  };
  for (const edgebaseDir of [backendEdgebaseDir, localEdgebaseDir]) {
    if (existsSync(edgebaseDir)) visit(edgebaseDir);
  }

  return plan.sort((a, b) => pathDepth(b.source) - pathDepth(a.source));
}

/** @param {Array<{ source: string, destination: string }>} plan */
export function assertCollisionFreePathPlan(plan) {
  const destinations = new Set();
  const collisions = [];
  for (const item of plan) {
    if (destinations.has(item.destination) || pathEntryExists(item.destination)) {
      collisions.push(item.destination);
    }
    destinations.add(item.destination);
  }
  if (collisions.length) {
    throw new Error(
      `Local namespace migration refused to overwrite ${collisions.length} existing destination path(s):\n${collisions
        .map((path) => `- ${path}`)
        .join('\n')}`,
    );
  }
}

/**
 * Select processes that can write this checkout's local EdgeBase state.
 * Commands alone are insufficient for generic `workerd` names, so callers
 * should provide a cwd when it can be resolved from the OS process table.
 *
 * @param {Array<{ pid: number, command: string, cwd?: string, portListener?: boolean }>} processes
 * @param {string} root
 */
export function projectOwnedRuntimeProcesses(processes, root) {
  const projectRoot = resolve(root);
  const backendRoot = join(projectRoot, 'backend');
  const targetRoot = join(backendRoot, '.edgebase', 'targets', 'dev-app');
  return processes.filter((process) => {
    if (!process.portListener && !RUNTIME_COMMAND_PATTERN.test(process.command)) return false;
    const commandOwnsProject =
      process.command.includes(backendRoot) || process.command.includes(targetRoot);
    const cwd = process.cwd ? resolve(process.cwd) : '';
    const cwdOwnsProject = cwd === projectRoot || cwd === backendRoot || cwd.startsWith(`${backendRoot}${sep}`);
    return commandOwnsProject || cwdOwnsProject;
  });
}

function processCwd(pid) {
  const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return '';
  return result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('n'))
    ?.slice(1) ?? '';
}

function listedProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('Could not inspect running processes; refusing to migrate local runtime state.');
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      const pid = Number(match[1]);
      const command = match[2];
      return {
        pid,
        command,
        cwd: RUNTIME_COMMAND_PATTERN.test(command) ? processCwd(pid) : '',
      };
    })
    .filter(Boolean);
}

function configuredDevPort() {
  const env = canonicalizeHanjiEnvironment(process.env);
  try {
    const url = new URL(String(env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787'));
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    return 8787;
  }
}

function listeningPids(port) {
  const result = spawnSync(
    'lsof',
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
    { encoding: 'utf8' },
  );
  if (result.error?.code === 'ENOENT') {
    throw new Error('Could not run lsof for the local runtime port; refusing to migrate local runtime state.');
  }
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

export function activeProjectRuntimeProcesses(root = repoRoot) {
  const processes = listedProcesses();
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const portProcesses = listeningPids(configuredDevPort())
    .map((pid) => {
      const process = byPid.get(pid) ?? { pid, command: '', cwd: '' };
      return { ...process, cwd: process.cwd || processCwd(pid), portListener: true };
    });
  return projectOwnedRuntimeProcesses(
    [...new Map([...processes, ...portProcesses].map((process) => [process.pid, process])).values()],
    root,
  );
}

/** @param {Array<{ source: string, destination: string }>} completed */
export function rollbackPathRenames(
  completed,
  { rename = renameSync, pathExists = pathEntryExists } = {},
) {
  const errors = [];
  for (const item of [...completed].reverse()) {
    try {
      if (!pathExists(item.destination)) {
        throw new Error('renamed destination is missing');
      }
      if (pathExists(item.source)) {
        throw new Error('original source path was recreated');
      }
      rename(item.destination, item.source);
    } catch (error) {
      errors.push({ item, error });
    }
  }
  return errors;
}

/** @param {Array<{ source: string, destination: string }>} plan */
export function applyPathRenamePlan(
  plan,
  { rename = renameSync, pathExists = pathEntryExists } = {},
) {
  const completed = [];
  try {
    for (const item of plan) {
      if (!pathExists(item.source)) {
        throw new Error(`Migration source disappeared before rename: ${item.source}`);
      }
      if (pathExists(item.destination)) {
        throw new Error(`Migration destination appeared before rename: ${item.destination}`);
      }
      rename(item.source, item.destination);
      completed.push(item);
    }
    return completed;
  } catch (error) {
    const rollbackErrors = rollbackPathRenames(completed, { rename, pathExists });
    const rollbackStatus = rollbackErrors.length
      ? `rollback failed for ${rollbackErrors.length} path(s); restore the pre-migration backup`
      : 'completed path renames were rolled back';
    throw new Error(
      `Path migration failed: ${error instanceof Error ? error.message : String(error)}; ${rollbackStatus}.`,
      { cause: error },
    );
  }
}

function pathDepth(path) {
  return resolve(path).split(sep).length;
}

export function localEnvSearchDirectories(root) {
  return [
    root,
    join(root, 'backend'),
    join(root, 'web'),
    join(root, 'mcp'),
    join(root, '.edgebase', 'docker'),
  ];
}

function ignoredEnvFiles(root) {
  const files = [];
  for (const directory of localEnvSearchDirectories(root)) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name !== '.env' && entry.name !== '.dev.vars' && !entry.name.startsWith('.env.')) {
        continue;
      }
      const path = join(directory, entry.name);
      const check = spawnSync('git', ['check-ignore', '--quiet', '--', relative(root, path)], {
        cwd: root,
        stdio: 'ignore',
      });
      if (check.status === 0) files.push(path);
    }
  }
  return files.sort();
}

function prepareEnvPlan(root) {
  const plan = [];
  for (const path of ignoredEnvFiles(root)) {
    const source = readFileSync(path, 'utf8');
    const result = migrateEnvText(source);
    if (result.changed) plan.push({ path, source, ...result });
  }
  return plan;
}

function writeFileAtomically(path, text) {
  const mode = statSync(path).mode;
  const temporary = join(dirname(path), `.${basename(path)}.hanji-migration-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function migrateLocalNamespace({
  root = repoRoot,
  apply = false,
  backupConfirmed = false,
  runtimeCheck = activeProjectRuntimeProcesses,
} = {}) {
  const pathPlan = collectPathRenamePlan(root);
  assertCollisionFreePathPlan(pathPlan);
  const envPlan = prepareEnvPlan(root);

  if (apply) {
    if (!backupConfirmed) {
      throw new Error(
        `Create a restorable backup of ${BACKUP_SCOPE} first, then rerun with --backup-confirmed. Recovery: stop the runtime and restore that complete backup before retrying.`,
      );
    }
    const activeRuntimes = runtimeCheck(root);
    if (activeRuntimes.length) {
      throw new Error(
        `Detected ${activeRuntimes.length} project-owned EdgeBase/Wrangler/workerd process(es). Stop them before applying the migration (PIDs: ${activeRuntimes.map((item) => item.pid).join(', ')}).`,
      );
    }

    const completedPaths = applyPathRenamePlan(pathPlan);
    const completedEnv = [];
    try {
      for (const item of envPlan) {
        if (readFileSync(item.path, 'utf8') !== item.source) {
          throw new Error(`Ignored environment file changed during migration: ${item.path}`);
        }
        writeFileAtomically(item.path, item.text);
        completedEnv.push(item);
      }
    } catch (error) {
      const envRollbackErrors = [];
      for (const item of [...completedEnv].reverse()) {
        try {
          writeFileAtomically(item.path, item.source);
        } catch (rollbackError) {
          envRollbackErrors.push({ item, error: rollbackError });
        }
      }
      const pathRollbackErrors = rollbackPathRenames(completedPaths);
      const rollbackFailures = envRollbackErrors.length + pathRollbackErrors.length;
      const rollbackStatus = rollbackFailures
        ? `automatic rollback failed for ${rollbackFailures} item(s); restore the pre-migration backup`
        : 'all completed changes were rolled back';
      throw new Error(
        `Environment migration failed: ${error instanceof Error ? error.message : String(error)}; ${rollbackStatus}.`,
        { cause: error },
      );
    }
  }

  return {
    apply,
    pathRenames: pathPlan.length,
    envFiles: envPlan.length,
    envAssignments: envPlan.reduce((sum, item) => sum + item.renamedAssignments, 0),
    retiredAssignments: envPlan.reduce((sum, item) => sum + item.removedRetiredAssignments, 0),
  };
}

function parseArgs(args) {
  let apply = false;
  let backupConfirmed = false;
  for (const arg of args) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--backup-confirmed') {
      backupConfirmed = true;
      continue;
    }
    if (arg === '--dry-run') continue;
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { apply, backupConfirmed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = migrateLocalNamespace(parseArgs(process.argv.slice(2)));
    const mode = result.apply ? 'applied' : 'dry run';
    console.log(
      `PASS Hanji local namespace migration ${mode}: ` +
        `${result.pathRenames} path rename(s), ${result.envFiles} env file(s), ` +
        `${result.envAssignments} env assignment rename(s), ` +
        `${result.retiredAssignments} retired assignment removal(s).`,
    );
    if (!result.apply && (result.pathRenames > 0 || result.envFiles > 0)) {
      console.log(`Stop the local runtime and create a restorable backup of ${BACKUP_SCOPE}.`);
      console.log('Then rerun with --apply --backup-confirmed. Restore the backup before retrying if rollback reports a failure.');
    }
  } catch (error) {
    console.error(`FAIL Hanji local namespace migration: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
