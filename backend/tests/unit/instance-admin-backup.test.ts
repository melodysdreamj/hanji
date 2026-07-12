import { describe, expect, it } from 'vitest';

import { POST } from '../../functions/instance-admin';
import { fakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

describe('instance admin backup snapshot', () => {
  it('fans workspace content tables out across every workspace database', async () => {
    const central = fakeDb({
      instance_settings: [{ id: 'global', instanceAdminUserIds: ['instance-admin'] }],
      workspaces: [
        { id: 'ws-1', name: 'One', ownerId: 'owner-1' },
        { id: 'ws-2', name: 'Two', ownerId: 'owner-2' },
      ],
      notifications: [{ id: 'notice-central', workspaceId: 'ws-1' }],
      // Content rows left behind in the pre-split central database must never
      // displace the authoritative per-workspace rows in a new snapshot.
      pages: [{ id: 'stale-central-page', workspaceId: 'ws-1' }],
      blocks: [{ id: 'stale-central-block', pageId: 'stale-central-page' }],
    });
    const workspaceDbs = new Map([
      ['ws-1', fakeDb({
        pages: [{ id: 'page-1', workspaceId: 'ws-1' }],
        blocks: [{ id: 'block-1', pageId: 'page-1' }],
        page_permissions: [{
          id: 'permission-1',
          workspaceId: 'ws-1',
          pageId: 'page-1',
          principalType: 'user',
          principalId: 'viewer-1',
        }],
      })],
      ['ws-2', fakeDb({
        pages: [{ id: 'page-2', workspaceId: 'ws-2' }],
        blocks: [{ id: 'block-2', pageId: 'page-2' }],
        page_permissions: [{
          id: 'permission-2',
          workspaceId: 'ws-2',
          pageId: 'page-2',
          principalType: 'user',
          principalId: 'viewer-2',
        }],
      })],
    ]);

    const result = await handlerOf(POST)({
      auth: { id: 'instance-admin', email: 'admin@example.com' },
      admin: {
        auth: {},
        db(namespace: string, instanceId?: string) {
          if (namespace === 'app') return central;
          const database = instanceId ? workspaceDbs.get(instanceId) : undefined;
          if (!database) throw new Error(`Unknown workspace database: ${instanceId ?? ''}`);
          return database;
        },
      },
      request: new Request('http://localhost/functions/instance-admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'createBackupSnapshot' }),
      }),
    }) as {
      snapshot: {
        tableCounts: Record<string, number>;
        tables: Record<string, Array<Record<string, unknown>>>;
      };
    };

    expect(result.snapshot.tables.pages.map((row) => row.id).sort()).toEqual(['page-1', 'page-2']);
    expect(result.snapshot.tables.blocks.map((row) => row.id).sort()).toEqual(['block-1', 'block-2']);
    expect(result.snapshot.tables.page_permissions.map((row) => row.id).sort()).toEqual([
      'permission-1',
      'permission-2',
    ]);
    expect(result.snapshot.tables.notifications.map((row) => row.id)).toEqual(['notice-central']);
    expect(result.snapshot.tableCounts.pages).toBe(2);
    expect(result.snapshot.tableCounts.blocks).toBe(2);
  });
});
