import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { findHanjiNamespaceViolations } from './verify-hanji-namespace.mjs';

const formerPrimary = ['notion', 'like'].join('');
const formerSecondary = ['ink', 'line'].join('');
const roots = [];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'hanji-namespace-guard-'));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Hanji namespace guard', () => {
  it('detects old product names and does not confuse Markdown link parser identifiers', () => {
    const files = ['src/product.ts', 'src/markdown.ts'];
    const primaryVariants = [
      formerPrimary,
      ['Notion', '/', 'Like'].join(''),
      ['Notion', '.', 'Like'].join(''),
      ['Notion', ' ', 'Like'].join(''),
      ['노션', ' ', '라이크'].join(''),
    ];
    const secondaryVariants = [
      formerSecondary,
      ['Ink', 'Line'].join(''),
      ['ink', '-', 'line'].join(''),
      ['ink', '_', 'line'].join(''),
      ['잉크', ' ', '라인'].join(''),
    ];
    const root = fixture({
      [files[0]]: [...primaryVariants, ...secondaryVariants]
        .map((value, index) => `export const old${index} = ${JSON.stringify(value)};`)
        .join('\n'),
      [files[1]]: 'export function parseMarkdownLinkLine() {}\n',
    });

    const violations = findHanjiNamespaceViolations({ root, files });
    assert.equal(violations.length, primaryVariants.length + secondaryVariants.length);
    assert.deepEqual(new Set(violations.map((item) => item.path)), new Set(['src/product.ts']));
  });

  it('scans released locale catalogs but leaves hidden translation targets to i18n checks', () => {
    const files = [
      'web/src/locales/en/importDialog.json',
      'web/src/locales/id/importDialog.json',
    ];
    const oldName = ['Notion', 'Like'].join('');
    const root = fixture({
      [files[0]]: JSON.stringify({ label: oldName }),
      [files[1]]: JSON.stringify({ label: oldName }),
    });

    const violations = findHanjiNamespaceViolations({ root, files });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, files[0]);
  });

  it('allows only the exact read-only compatibility declarations', () => {
    const path = 'mcp/src/legacy-product-compat.mjs';
    const valid = `const LEGACY_URI_SCHEME = "${formerPrimary}";\n`;
    const root = fixture({ [path]: valid });
    assert.deepEqual(findHanjiNamespaceViolations({ root, files: [path] }), []);

    writeFileSync(
      join(root, path),
      `${valid}const LEGACY_UNRELATED_PRODUCT = "${formerPrimary}-new-write";\n`,
    );
    const violations = findHanjiNamespaceViolations({ root, files: [path] });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 2);
  });

  it('allows only the generated read-compatibility payload fragments', () => {
    const path = 'web/dist/assets/app.js';
    const allowed = [
      `application/x-${formerPrimary}-blocks`,
      `${formerSecondary}.export`,
      `${formerPrimary}.current_page`,
    ];
    const root = fixture({ [path]: allowed.map((value) => JSON.stringify(value)).join(';') });
    assert.deepEqual(
      findHanjiNamespaceViolations({ root, files: [path], generated: true }),
      [],
    );

    writeFileSync(
      join(root, path),
      `${allowed.map((value) => JSON.stringify(value)).join(';')};${JSON.stringify(['Notion', '/', 'Like'].join(''))}`,
    );
    const violations = findHanjiNamespaceViolations({ root, files: [path], generated: true });
    assert.equal(violations.length, 1);
  });
});
