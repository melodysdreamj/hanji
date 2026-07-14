#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultEnvFile = resolve(repoRoot, 'backend', '.env.release');

function assignment(source, name) {
  const matches = [...source.matchAll(new RegExp(`^[\\t ]*${name}[\\t ]*=[\\t ]*(.*)$`, 'gm'))];
  if (matches.length > 1) throw new Error(`${name} is declared more than once in .env.release.`);
  if (!matches.length) return null;
  const raw = matches[0][1].trim();
  return raw.length >= 2 && (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) ? raw.slice(1, -1) : raw;
}

function upsertAssignment(source, name, value) {
  const pattern = new RegExp(`^[\\t ]*${name}[\\t ]*=.*$`, 'm');
  if (pattern.test(source)) return source.replace(pattern, `${name}=${value}`);
  return `${source.replace(/\s*$/, '')}\n${name}=${value}\n`;
}

function atomicRewrite(path, source, mode) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, source, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

export function prepareBrowserSetup({
  envFile = defaultEnvFile,
  createToken = () => randomBytes(32).toString('base64url'),
} = {}) {
  const mode = statSync(envFile).mode & 0o777;
  const source = readFileSync(envFile, 'utf8');
  const masterEmail = assignment(source, 'HANJI_MASTER_EMAIL') ?? '';
  const masterPassword = assignment(source, 'HANJI_MASTER_PASSWORD') ?? '';
  if (Boolean(masterEmail) !== Boolean(masterPassword)) {
    throw new Error(
      'HANJI_MASTER_EMAIL and HANJI_MASTER_PASSWORD must both be empty for browser setup, or both be set for legacy noninteractive provisioning.',
    );
  }

  let next = upsertAssignment(source, 'HANJI_BROWSER_SETUP', 'true');
  next = upsertAssignment(next, 'HANJI_TRUST_SELF_HOSTED_PROXY', 'false');
  let generated = false;
  if (!masterEmail) {
    const currentToken = assignment(next, 'HANJI_BROWSER_SETUP_TOKEN') ?? '';
    if (!currentToken) {
      const token = createToken();
      if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) {
        throw new Error('Generated HANJI_BROWSER_SETUP_TOKEN did not meet the required high-entropy URL-safe format.');
      }
      next = upsertAssignment(next, 'HANJI_BROWSER_SETUP_TOKEN', token);
      generated = true;
    }
  }

  if (next !== source) atomicRewrite(envFile, next, mode);
  const finalSource = next;
  return {
    browserSetup: assignment(finalSource, 'HANJI_BROWSER_SETUP') === 'true',
    generated,
    legacyMasterProvisioning: Boolean(masterEmail),
    origin: assignment(finalSource, 'HANJI_APP_ORIGIN') ?? '',
    token: assignment(finalSource, 'HANJI_BROWSER_SETUP_TOKEN') ?? '',
  };
}

export function browserSetupUrl(origin, token) {
  if (!origin || !token) return '';
  const parsed = new URL(origin);
  parsed.hash = `setup_token=${encodeURIComponent(token)}`;
  return parsed.toString();
}

function main() {
  const envFileFlag = process.argv.indexOf('--env-file');
  const envFile = envFileFlag >= 0
    ? resolve(process.cwd(), process.argv[envFileFlag + 1] ?? '')
    : defaultEnvFile;
  const result = prepareBrowserSetup({ envFile });
  if (process.argv.includes('--print-url')) {
    if (result.legacyMasterProvisioning) {
      console.log('Legacy environment-provisioned master credentials are configured; no browser setup link is needed.');
      return;
    }
    const url = browserSetupUrl(result.origin, result.token);
    if (!url) throw new Error('HANJI_APP_ORIGIN and HANJI_BROWSER_SETUP_TOKEN are required to print the setup link.');
    console.log('Private first-administrator setup link (opens once, then setup closes):');
    console.log(url);
    return;
  }
  console.log(
    result.generated
      ? 'Generated a private one-time browser setup capability in backend/.env.release.'
      : 'Browser first-run setup capability is ready in backend/.env.release.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL browser setup preparation: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
