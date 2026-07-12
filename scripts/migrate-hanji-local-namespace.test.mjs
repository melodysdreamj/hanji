import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  assertCollisionFreePathPlan,
  applyPathRenamePlan,
  canonicalizeHanjiEnvironment,
  legacyHanjiEnvironmentNames,
  collectPathRenamePlan,
  localEnvSearchDirectories,
  migrateEnvText,
  legacyHanjiEnvAssignmentNames,
  migrateLocalNamespace,
  migratedPathComponent,
  projectOwnedRuntimeProcesses,
} from './migrate-hanji-local-namespace.mjs';
import { setupDevEnvironment } from './setup-dev-env.mjs';

const oldUpperPrefix = ['NOTION', 'LIKE_'].join('');
const oldLowerPrefix = ['notion', 'like-'].join('');
const oldSecondaryName = ['ink', 'line'].join('');
const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Hanji local namespace migration', () => {
  it('renames env keys without changing values and removes the retired auto-login flag', () => {
    const source = [
      `${oldUpperPrefix}MASTER_EMAIL=master@example.com`,
      `${oldUpperPrefix}MASTER_PASSWORD=value-with-${oldUpperPrefix}inside`,
      `${oldUpperPrefix}MASTER_DEV_AUTOLOGIN=true`,
      'EDGEBASE_SETTING=kept',
      '',
    ].join('\n');

    const result = migrateEnvText(source);
    assert.equal(
      result.text,
      [
        'HANJI_MASTER_EMAIL=master@example.com',
        `HANJI_MASTER_PASSWORD=value-with-${oldUpperPrefix}inside`,
        'EDGEBASE_SETTING=kept',
        '',
      ].join('\n'),
    );
    assert.equal(result.renamedAssignments, 2);
    assert.equal(result.removedRetiredAssignments, 1);
  });

  it('fails closed when old and canonical env assignments coexist', () => {
    assert.throws(
      () => migrateEnvText(`${oldUpperPrefix}MASTER_EMAIL=old\nHANJI_MASTER_EMAIL=new\n`),
      /duplicate canonical assignments: HANJI_MASTER_EMAIL/,
    );
  });

  it('normalizes process-style legacy env input while preserving canonical precedence', () => {
    assert.deepEqual(
      canonicalizeHanjiEnvironment({
        [`${oldUpperPrefix}APP_ORIGIN`]: 'https://old.example',
        HANJI_APP_ORIGIN: 'https://hanji.example',
        [`${oldUpperPrefix}MASTER_EMAIL`]: 'master@example.com',
      }),
      {
        [`${oldUpperPrefix}APP_ORIGIN`]: 'https://old.example',
        HANJI_APP_ORIGIN: 'https://hanji.example',
        [`${oldUpperPrefix}MASTER_EMAIL`]: 'master@example.com',
        HANJI_MASTER_EMAIL: 'master@example.com',
      },
    );
  });

  it('reports active pre-Hanji environment names without exposing values', () => {
    assert.deepEqual(
      legacyHanjiEnvironmentNames({
        HANJI_MASTER_EMAIL: 'canonical-private-value',
        [`${oldUpperPrefix}TOKEN`]: 'legacy-private-value',
        [`${oldUpperPrefix}APP_ORIGIN`]: 'legacy-private-origin',
      }),
      [`${oldUpperPrefix}APP_ORIGIN`, `${oldUpperPrefix}TOKEN`],
    );
  });

  it('stops dev setup before changing files when pre-Hanji env assignments remain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hanji-setup-upgrade-'));
    temporaryRoots.push(root);
    const backend = join(root, 'backend');
    mkdirSync(backend, { recursive: true });
    const envPath = join(backend, '.env.development');
    const source = `${oldUpperPrefix}MASTER_EMAIL=private-value\n`;
    writeFileSync(envPath, source);

    assert.deepEqual(legacyHanjiEnvAssignmentNames(source), [`${oldUpperPrefix}MASTER_EMAIL`]);
    await assert.rejects(
      setupDevEnvironment({ root }),
      /Pre-Hanji environment assignments remain.*No files were changed.*migrate-hanji-local-namespace/s,
    );
    assert.equal(readFileSync(envPath, 'utf8'), source);
    assert.equal(existsSync(join(backend, '.dev.vars')), false);
    assert.equal(existsSync(join(root, 'web', '.env.local')), false);
  });

  it('stops dev setup before changing files when the current process uses a pre-Hanji name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hanji-setup-process-upgrade-'));
    temporaryRoots.push(root);
    mkdirSync(join(root, 'backend'), { recursive: true });

    await assert.rejects(
      setupDevEnvironment({
        root,
        environment: { [`${oldUpperPrefix}TOKEN`]: 'private-value' },
      }),
      new RegExp(`Pre-Hanji environment variable names remain.*${oldUpperPrefix}TOKEN.*No files were changed`),
    );
    assert.equal(existsSync(join(root, 'backend', '.env.development')), false);
    assert.equal(existsSync(join(root, 'backend', '.dev.vars')), false);
    assert.equal(existsSync(join(root, 'web', '.env.local')), false);
  });

  it('renames backend state, dev targets, and old product names in local artifact paths', () => {
    assert.equal(
      migratedPathComponent(`${oldLowerPrefix}backend-storage`),
      'hanji-backend-storage',
    );
    assert.equal(
      migratedPathComponent(`${oldLowerPrefix}presence-check`, { devTarget: true }),
      'hanji-presence-check',
    );
    assert.equal(migratedPathComponent(`${oldSecondaryName}-capture.png`), 'hanji-capture.png');
    assert.equal(migratedPathComponent(['노션', '_', '라이크-기록.json'].join('')), '한지-기록.json');
    assert.equal(migratedPathComponent('notion-import-smoke', { devTarget: true }), 'notion-import-smoke');
  });

  it('includes the self-host Docker env directory in ignored-env discovery', () => {
    assert.ok(
      localEnvSearchDirectories('/repo').includes(join('/repo', '.edgebase', 'docker')),
    );
  });

  it('detects only project-owned runtime commands or project-owned port listeners', () => {
    const root = '/repo/hanji';
    const active = projectOwnedRuntimeProcesses([
      {
        pid: 10,
        command: `/usr/bin/node ${root}/backend/node_modules/wrangler/bin/wrangler.js dev`,
        cwd: `${root}/backend`,
      },
      { pid: 11, command: '/usr/bin/workerd serve', cwd: '/repo/other' },
      { pid: 12, command: '/usr/bin/node unrelated-server.js', cwd: root, portListener: true },
      { pid: 13, command: '/usr/bin/node unrelated-server.js', cwd: root },
    ], root);
    assert.deepEqual(active.map((process) => process.pid), [10, 12]);
  });

  it('requires a backup acknowledgement and a stopped project runtime before apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'hanji-namespace-safety-'));
    temporaryRoots.push(root);
    const source = join(root, 'backend', '.edgebase', 'dev', `${oldLowerPrefix}probe`);
    mkdirSync(source, { recursive: true });

    assert.throws(
      () => migrateLocalNamespace({ root, apply: true, runtimeCheck: () => [] }),
      /restorable backup of backend\/\.edgebase, root \.edgebase, and every target ignored env file/,
    );
    assert.throws(
      () => migrateLocalNamespace({
        root,
        apply: true,
        backupConfirmed: true,
        runtimeCheck: () => [{ pid: 4321 }],
      }),
      /Stop them before applying.*4321/,
    );
    assert.ok(existsSync(source));
  });

  it('rolls completed path renames back in reverse order when a later rename fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'hanji-namespace-rollback-'));
    temporaryRoots.push(root);
    const first = join(root, 'first-old');
    const second = join(root, 'second-old');
    const firstNext = join(root, 'first-new');
    const secondNext = join(root, 'second-new');
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');
    let calls = 0;

    assert.throws(
      () => applyPathRenamePlan(
        [
          { source: first, destination: firstNext },
          { source: second, destination: secondNext },
        ],
        {
          rename: (source, destination) => {
            calls += 1;
            if (calls === 2) throw new Error('injected rename failure');
            renameSync(source, destination);
          },
        },
      ),
      /completed path renames were rolled back/,
    );
    assert.ok(existsSync(first));
    assert.ok(existsSync(second));
    assert.equal(existsSync(firstNext), false);
    assert.equal(existsSync(secondNext), false);
  });

  it('collects deepest paths first and refuses an existing destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'hanji-namespace-test-'));
    temporaryRoots.push(root);
    const state = join(root, 'backend', '.edgebase', 'dev', `${oldLowerPrefix}probe`, 'state');
    mkdirSync(state, { recursive: true });
    const oldStorage = join(state, `${oldLowerPrefix}backend-storage`);
    writeFileSync(oldStorage, 'fixture');

    const plan = collectPathRenamePlan(root);
    assert.equal(plan.length, 2);
    assert.ok(plan[0].source.endsWith(`${oldLowerPrefix}backend-storage`));
    assert.ok(plan[1].source.endsWith(`${oldLowerPrefix}probe`));
    assertCollisionFreePathPlan(plan);

    writeFileSync(plan[0].destination, 'collision');
    assert.throws(() => assertCollisionFreePathPlan(plan), /refused to overwrite/);
  });

  it('treats a dangling destination symlink as an overwrite collision', () => {
    const root = mkdtempSync(join(tmpdir(), 'hanji-namespace-symlink-'));
    temporaryRoots.push(root);
    const state = join(root, 'backend', '.edgebase', 'dev');
    mkdirSync(state, { recursive: true });
    const source = join(state, `${oldLowerPrefix}probe`);
    const destination = join(state, 'hanji-probe');
    writeFileSync(source, 'fixture');
    symlinkSync(join(root, 'missing-target'), destination);

    assert.equal(existsSync(destination), false, 'fixture must be a dangling symlink');
    const plan = collectPathRenamePlan(root);
    assert.deepEqual(plan, [{ source, destination }]);
    assert.throws(() => assertCollisionFreePathPlan(plan), /refused to overwrite/);
    assert.throws(() => applyPathRenamePlan(plan), /destination appeared before rename/);
    assert.ok(existsSync(source));
  });

  it('includes ignored root artifact paths without rewriting real Notion references', () => {
    const root = mkdtempSync(join(tmpdir(), 'hanji-namespace-artifacts-'));
    temporaryRoots.push(root);
    const artifact = join(root, '.edgebase', `notion-vs-${oldSecondaryName}`, `${oldSecondaryName}-capture.png`);
    mkdirSync(join(root, '.edgebase', `notion-vs-${oldSecondaryName}`), { recursive: true });
    writeFileSync(artifact, 'synthetic');

    const plan = collectPathRenamePlan(root);
    assert.equal(plan.length, 2);
    assert.ok(plan.some((item) => item.destination.endsWith('hanji-capture.png')));
    assert.ok(plan.some((item) => item.destination.endsWith('notion-vs-hanji')));
  });
});
