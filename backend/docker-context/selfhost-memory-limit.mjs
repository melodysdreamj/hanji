import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIB_BYTES = 1024 * 1024;
const GIB_BYTES = 1024 * MIB_BYTES;
const AUTO_HOST_FLOOR_GIB = 4;
const DEFAULT_LIMIT_FLOOR_MIB = 2048;
const MINIMUM_OVERRIDE_MIB = 1536;
const MAXIMUM_OVERRIDE_MIB = 1024 * 1024;

function nominalHostGiB(totalMemoryBytes) {
  if (
    typeof totalMemoryBytes !== 'number'
    || !Number.isFinite(totalMemoryBytes)
    || totalMemoryBytes <= 0
  ) {
    return null;
  }
  // Linux MemTotal excludes kernel-reserved memory, so a physically installed
  // whole-GiB capacity can appear slightly more than half a GiB below its
  // nominal boundary (the observed 16 GiB DS918+ reports about 15.48 GiB).
  // Round upward to recover installed capacity instead of under-sizing it.
  const value = Math.ceil(totalMemoryBytes / GIB_BYTES);
  return value > 0 ? value : null;
}

function parseOverrideMiB(override) {
  if (typeof override !== 'string') {
    throw new Error('The explicit memory limit must be a string such as 1536m or 8g.');
  }
  const value = override.trim();
  const match = /^([1-9][0-9]*)([mMgG])$/.exec(value);
  if (!match) {
    throw new Error('The explicit memory limit must use whole MiB or GiB, for example 1536m or 8g.');
  }
  const quantity = Number(match[1]);
  const limitMiB = quantity * (match[2].toLowerCase() === 'g' ? 1024 : 1);
  if (
    !Number.isSafeInteger(limitMiB)
    || limitMiB < MINIMUM_OVERRIDE_MIB
    || limitMiB > MAXIMUM_OVERRIDE_MIB
  ) {
    throw new Error(
      `The explicit memory limit must be between ${MINIMUM_OVERRIDE_MIB} MiB and 1 TiB.`,
    );
  }
  return limitMiB;
}

export function totalMemoryBytesFromMeminfo(source) {
  if (typeof source !== 'string') return null;
  const match = /^MemTotal:\s*([1-9][0-9]*)\s+kB\s*$/mi.exec(source);
  if (!match) return null;
  const kibibytes = Number(match[1]);
  const bytes = kibibytes * 1024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function resolveSelfHostMemoryLimit({
  totalMemoryBytes,
  override,
} = {}) {
  const hostGiB = nominalHostGiB(totalMemoryBytes);
  const hasOverride = override !== undefined && override !== null;
  if (hasOverride) {
    const limitMiB = parseOverrideMiB(override);
    return {
      dockerValue: `${limitMiB}m`,
      limitMiB,
      nominalHostGiB: hostGiB,
      source: 'override',
    };
  }
  if (hostGiB === null) {
    throw new Error(
      'Could not detect host memory. Set HANJI_MEMORY_LIMIT to one explicit finite value such as 2048m.',
    );
  }
  if (hostGiB < AUTO_HOST_FLOOR_GIB) {
    throw new Error(
      `Automatic sizing requires 4 GiB or more of host RAM; detected about ${hostGiB} GiB. `
      + 'Use a host with >= 4 GiB, or set HANJI_MEMORY_LIMIT=1536m only after confirming DSM has enough headroom.',
    );
  }
  const limitMiB = Math.max(
    DEFAULT_LIMIT_FLOOR_MIB,
    Math.floor((hostGiB * 1024) / 2),
  );
  return {
    dockerValue: `${limitMiB}m`,
    limitMiB,
    nominalHostGiB: hostGiB,
    source: 'automatic',
  };
}

export function currentSelfHostMemoryLimit({
  override = process.env.HANJI_MEMORY_LIMIT,
  meminfoPath = '/proc/meminfo',
} = {}) {
  let totalMemoryBytes = null;
  try {
    totalMemoryBytes = totalMemoryBytesFromMeminfo(readFileSync(meminfoPath, 'utf8'));
  } catch {
    totalMemoryBytes = null;
  }
  return resolveSelfHostMemoryLimit({ totalMemoryBytes, override });
}

function printHelp() {
  process.stdout.write(
    'Usage: node /usr/local/bin/hanji-memory-limit.mjs [--json]\n'
    + 'Set HANJI_MEMORY_LIMIT=1536m (or another finite MiB/GiB value) to override automatic sizing.\n',
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg === '--help' || arg === '-h')) {
    printHelp();
    return;
  }
  if (args.some((arg) => arg !== '--json')) {
    throw new Error(`Unknown option: ${args.find((arg) => arg !== '--json')}`);
  }
  const result = currentSelfHostMemoryLimit();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const source = result.source === 'automatic'
    ? `automatic: 50% of about ${result.nominalHostGiB} GiB detected RAM`
    : 'explicit operator override';
  process.stderr.write(
    `Hanji memory policy: ${result.limitMiB} MiB (${source}); hard and memory-plus-swap limits stay equal.\n`,
  );
  process.stdout.write(`${result.dockerValue}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Hanji memory policy error: ${message}\n`);
    process.exitCode = 1;
  }
}
