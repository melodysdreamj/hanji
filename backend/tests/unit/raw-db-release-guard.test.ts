import { describe, expect, it } from 'vitest';

import config from '../../edgebase.config';

function rawTables() {
  const databases = config.databases ?? {};
  return Object.values(databases).flatMap((block) => Object.values(block.tables ?? {}));
}

describe('raw database release guard', () => {
  it('enforces deny-by-default access rules in every runtime', () => {
    expect(config.release).toBe(true);
  });

  it('keeps product tables functions-only', () => {
    const tables = rawTables();
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table).not.toHaveProperty('access');
      expect(table).not.toHaveProperty('public');
    }
  });
});
