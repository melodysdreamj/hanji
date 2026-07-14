import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { browserSetupUrl, prepareBrowserSetup } from './prepare-browser-setup.mjs';

const temporaryRoots = [];
const setupToken = 'abcdefghijklmnopqrstuvwxyzABCDEFGH0123456789_';

function envFile(source) {
  const root = mkdtempSync(join(tmpdir(), 'hanji-browser-setup-'));
  temporaryRoots.push(root);
  const path = join(root, '.env.release');
  writeFileSync(path, source, { mode: 0o600 });
  return path;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('generates and then reuses one private hosted setup token without changing file mode', () => {
  const path = envFile([
    'HANJI_APP_ORIGIN=https://app.example.com',
    'HANJI_BROWSER_SETUP=false',
    'HANJI_BROWSER_SETUP_TOKEN=',
    'HANJI_MASTER_EMAIL=',
    'HANJI_MASTER_PASSWORD=',
    '',
  ].join('\n'));

  const first = prepareBrowserSetup({ envFile: path, createToken: () => setupToken });
  assert.deepEqual(first, {
    browserSetup: true,
    generated: true,
    legacyMasterProvisioning: false,
    origin: 'https://app.example.com',
    token: setupToken,
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(path, 'utf8'), /^HANJI_BROWSER_SETUP=true$/m);
  assert.match(readFileSync(path, 'utf8'), /^HANJI_TRUST_SELF_HOSTED_PROXY=false$/m);
  assert.match(readFileSync(path, 'utf8'), new RegExp(`^HANJI_BROWSER_SETUP_TOKEN=${setupToken}$`, 'm'));

  const second = prepareBrowserSetup({
    envFile: path,
    createToken: () => { throw new Error('token must not rotate'); },
  });
  assert.equal(second.generated, false);
  assert.equal(second.token, setupToken);
});

test('prints the capability only in the URL fragment', () => {
  const url = browserSetupUrl('https://app.example.com', setupToken);
  assert.equal(url, `https://app.example.com/#setup_token=${setupToken}`);
  assert.equal(new URL(url).search, '');
});

test('preserves legacy noninteractive master provisioning as compatibility', () => {
  const path = envFile([
    'HANJI_APP_ORIGIN=https://app.example.com',
    'HANJI_MASTER_EMAIL=master@example.com',
    'HANJI_MASTER_PASSWORD=MasterPass!2026X',
    'HANJI_BROWSER_SETUP_TOKEN=',
    '',
  ].join('\n'));

  const result = prepareBrowserSetup({
    envFile: path,
    createToken: () => { throw new Error('legacy master path must not create a token'); },
  });
  assert.equal(result.legacyMasterProvisioning, true);
  assert.equal(result.token, '');
  assert.match(readFileSync(path, 'utf8'), /^HANJI_BROWSER_SETUP=true$/m);
});

test('rejects a partial legacy master pair without modifying the file', () => {
  const path = envFile([
    'HANJI_APP_ORIGIN=https://app.example.com',
    'HANJI_MASTER_EMAIL=master@example.com',
    'HANJI_MASTER_PASSWORD=',
    '',
  ].join('\n'));
  const before = readFileSync(path, 'utf8');

  assert.throws(() => prepareBrowserSetup({ envFile: path }), /must both be empty.*or both be set/);
  assert.equal(readFileSync(path, 'utf8'), before);
});
