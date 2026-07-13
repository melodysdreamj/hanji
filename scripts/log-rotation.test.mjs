import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { rotateFile } from './lib/log-rotation.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('rotation keeps a bounded newest-first backup chain', () => {
  const root = mkdtempSync(join(tmpdir(), 'hanji-log-rotation-'));
  roots.push(root);
  const path = join(root, 'runtime.log');
  writeFileSync(`${path}.1`, 'previous');
  writeFileSync(`${path}.2`, 'older');
  writeFileSync(`${path}.3`, 'oldest');
  writeFileSync(path, 'current-log-is-too-large');

  assert.equal(rotateFile(path, { maxBytes: 8, maxBackups: 3 }), true);
  assert.equal(readFileSync(`${path}.1`, 'utf8'), 'oo-large');
  assert.equal(readFileSync(`${path}.2`, 'utf8'), 'previous');
  assert.equal(readFileSync(`${path}.3`, 'utf8'), 'older');
});

test('rotation leaves a log at or below the limit untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'hanji-log-rotation-'));
  roots.push(root);
  const path = join(root, 'runtime.log');
  writeFileSync(path, 'small');
  writeFileSync(`${path}.1`, 'oversized-old-backup');

  assert.equal(rotateFile(path, { maxBytes: 5, maxBackups: 2 }), false);
  assert.equal(readFileSync(path, 'utf8'), 'small');
  assert.equal(readFileSync(`${path}.1`, 'utf8'), 'ackup');
});
