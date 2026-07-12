import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('server host-locale guards', () => {
  it('keeps API, public-share, and MCP numeric wire output deterministic', () => {
    const files = [
      resolve(process.cwd(), 'functions/page-query.ts'),
      resolve(process.cwd(), 'functions/share-mutation.ts'),
      resolve(process.cwd(), '../mcp/src/index.mjs'),
    ];
    const violations = files
      .filter((file) =>
        /new\s+Intl\.(?:NumberFormat|DateTimeFormat)\(\s*(?:undefined\s*)?(?:,|\))/.test(
          readFileSync(file, 'utf8'),
        ))
      .map((file) => file.replace(`${resolve(process.cwd(), '..')}/`, ''));

    expect(violations).toEqual([]);
  });
});
