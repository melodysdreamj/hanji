import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_CONTENT_TABLES } from '../../lib/workspace-db';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rootDir = resolve(backendDir, '..');

function stringArrayLiteral(source: string, name: string) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) throw new Error(`Could not find ${name} array literal.`);
  const values = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
  if (!values.length) throw new Error(`${name} array literal was empty.`);
  return values;
}

describe('workspace content table boundary', () => {
  it('keeps migration restore order in lockstep with runtime routing tables', () => {
    const script = readFileSync(resolve(rootDir, 'scripts/workspace-do-migrate.mjs'), 'utf8');
    expect(stringArrayLiteral(script, 'CONTENT_TABLES')).toEqual([...WORKSPACE_CONTENT_TABLES]);
  });

  it('keeps edgebase table placement sourced from the runtime routing constant', () => {
    const config = readFileSync(resolve(backendDir, 'edgebase.config.ts'), 'utf8');
    expect(config).toContain('const workspaceContentTableNames = WORKSPACE_CONTENT_TABLES;');
    expect(config).not.toContain("const workspaceContentTableNames = [");
  });
});
