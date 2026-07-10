import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_CONTENT_TABLES,
  boundedDb,
  isWorkspaceContentTable,
  type AdminDbAccessor,
} from '../../lib/workspace-db';
import type { DbRef } from '../../lib/app-types';

function stubDb(label: string, log: string[]): DbRef {
  return {
    table(name: string) {
      log.push(`${label}:table:${name}`);
      return {} as ReturnType<DbRef['table']>;
    },
    async transact(operations) {
      log.push(`${label}:transact:${operations.map((op) => op.table).join(',')}`);
      return { results: [] };
    },
  } as DbRef;
}

function stubAdmin(log: string[]): AdminDbAccessor {
  return {
    db(namespace: string, instanceId?: string) {
      return stubDb(instanceId ? `${namespace}/${instanceId}` : namespace, log);
    },
  };
}

describe('workspace-db boundary', () => {
  it('classifies the boundary constant consistently', () => {
    expect(isWorkspaceContentTable('pages')).toBe(true);
    expect(isWorkspaceContentTable('blocks')).toBe(true);
    expect(isWorkspaceContentTable('workspaces')).toBe(false);
    expect(isWorkspaceContentTable('organization_members')).toBe(false);
    expect(isWorkspaceContentTable('notifications')).toBe(false);
    expect(WORKSPACE_CONTENT_TABLES).toContain('page_permissions');
    expect(WORKSPACE_CONTENT_TABLES).toContain('share_links');
  });

  it('routes content tables to the workspace instance and the rest centrally', () => {
    const log: string[] = [];
    const db = boundedDb(stubAdmin(log), 'ws-42');
    db.table('pages');
    db.table('blocks');
    db.table('workspaces');
    db.table('organization_members');
    expect(log).toEqual([
      'workspace/ws-42:table:pages',
      'workspace/ws-42:table:blocks',
      'app:table:workspaces',
      'app:table:organization_members',
    ]);
  });

  it('delegates homogeneous transact batches to the matching side', async () => {
    const log: string[] = [];
    const db = boundedDb(stubAdmin(log), 'ws-42');
    await db.transact([
      { table: 'blocks', op: 'delete', id: 'b1' },
      { table: 'pages', op: 'delete', id: 'p1' },
    ]);
    await db.transact([
      { table: 'workspace_members', op: 'delete', id: 'wm1' },
    ]);
    expect(log).toEqual([
      // Change-log scope resolution reads each mutated record first…
      'workspace/ws-42:table:blocks',
      'workspace/ws-42:table:pages',
      // …then the content batch carries one appended change_log tombstone per
      // logged-table op, atomically. Central batches stay untouched.
      'workspace/ws-42:transact:blocks,pages,change_log,change_log',
      'app:transact:workspace_members',
    ]);
  });

  it('rejects transact batches that mix central and workspace tables', async () => {
    const log: string[] = [];
    const db = boundedDb(stubAdmin(log), 'ws-42');
    await expect(
      db.transact([
        { table: 'pages', op: 'delete', id: 'p1' },
        { table: 'workspaces', op: 'delete', id: 'ws-42' },
      ]),
    ).rejects.toThrow('split the batch per side');
    expect(log).toEqual([]);
  });
});
