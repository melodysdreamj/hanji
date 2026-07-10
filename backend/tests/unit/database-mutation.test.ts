import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/database-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction } from './helpers/function-context';

const OWNER = 'owner-1';

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    ...tables,
  });
}

describe('database-mutation createDatabase', () => {
  it('preserves a blank database title instead of storing New database', async () => {
    const database = db();
    const res = (await callFunction(POST, database, OWNER, {
      action: 'createDatabase',
      id: 'db-empty-title',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      title: '',
      seedRows: false,
      properties: [{ id: 'prop-name', name: 'Name', type: 'title', position: 1 }],
    })) as { page: Row; rows: Row[] };

    expect(res.page.id).toBe('db-empty-title');
    expect(res.page.title).toBe('');
    expect(database.tables.pages.find((page) => page.id === 'db-empty-title')?.title).toBe('');
    expect(res.rows).toHaveLength(0);
  });

  it('still preserves an explicitly typed New database title', async () => {
    const res = (await callFunction(POST, db(), OWNER, {
      action: 'createDatabase',
      id: 'db-explicit-title',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      title: 'New database',
      seedRows: false,
      properties: [{ id: 'prop-name', name: 'Name', type: 'title', position: 1 }],
    })) as { page: Row };

    expect(res.page.title).toBe('New database');
  });
});
