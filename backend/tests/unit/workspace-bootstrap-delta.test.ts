import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/workspace-bootstrap';
import { fakeDb, type FakeDb, type Row } from './helpers/fake-db';
import { callFunction } from './helpers/function-context';

const OWNER = 'owner';
const T_EDIT = '2026-07-08T00:00:10.000Z';

function pageRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Page ${id}`,
    position: 0,
    inTrash: false,
    isPublic: false,
    createdBy: OWNER,
    updatedAt: T_EDIT,
    ...extra,
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Team workspace', ownerId: OWNER }],
    workspace_members: [
      { id: 'wm-owner', workspaceId: 'ws1', userId: OWNER, role: 'owner', email: `${OWNER}@example.com` },
    ],
    pages: [],
    blocks: [],
    page_permissions: [],
    notifications: [],
    ...tables,
  });
}

describe('workspace-bootstrap pagesSince watermark', () => {
  it('returns the true max updatedAt as the watermark (no back-off)', async () => {
    // The pages watermark is the raw max so an idle workspace does not re-ship
    // the whole recent window; the same-ms race is closed by the boundary '>='
    // filter in ids mode, not by walking the watermark backwards.
    const database = db({ pages: [pageRow('p1')] });
    const res = (await callFunction(POST, database, OWNER, { workspaceId: 'ws1' })) as {
      pagesSyncedAt: string;
    };
    expect(res.pagesSyncedAt).toBe(T_EDIT);
  });

  it('re-delivers a page that committed in the same millisecond as the watermark', async () => {
    // Sync 1 sees only p1 and returns watermark = p1.updatedAt (the true max).
    // p2 commits with the SAME updatedAt right after the read. A strict
    // `updatedAt > pagesSince` filter would skip p2 forever; the ids-mode
    // boundary-inclusive `>=` re-scans the boundary ms (the client merges
    // changedPages by id, so the re-delivered p1 is harmless).
    const database = db({ pages: [pageRow('p1')] });
    const first = (await callFunction(POST, database, OWNER, { workspaceId: 'ws1' })) as {
      pagesSyncedAt: string;
    };

    database.tables.pages.push(pageRow('p2'));
    const second = (await callFunction(POST, database, OWNER, {
      workspaceId: 'ws1',
      pagesSince: first.pagesSyncedAt,
    })) as { pagesDelta?: boolean; deltaMode?: string; changedPages: Row[] };
    expect(second.pagesDelta).toBe(true);
    expect(second.deltaMode).toBe('ids');
    expect(second.changedPages.map((page) => page.id).sort()).toEqual(['p1', 'p2']);
  });

  it('re-delivers only boundary-ms pages on an idle workspace, not older ones', async () => {
    // Older pages sit strictly below the watermark; only pages at exactly the
    // boundary ms re-ship, preserving the O(changes) contract.
    const T_OLD = '2026-07-08T00:00:05.000Z';
    const database = db({
      pages: [pageRow('old', { updatedAt: T_OLD }), pageRow('boundary')],
    });
    const first = (await callFunction(POST, database, OWNER, { workspaceId: 'ws1' })) as {
      pagesSyncedAt: string;
    };
    const second = (await callFunction(POST, database, OWNER, {
      workspaceId: 'ws1',
      pagesSince: first.pagesSyncedAt,
    })) as { changedPages: Row[]; visiblePageIds: string[] };
    expect(second.changedPages.map((page) => page.id)).toEqual(['boundary']);
    expect(second.visiblePageIds.sort()).toEqual(['boundary', 'old']);
  });

  it('never walks the cursor backwards on an idle workspace', async () => {
    const database = db({ pages: [pageRow('p1')] });
    const first = (await callFunction(POST, database, OWNER, { workspaceId: 'ws1' })) as {
      pagesSyncedAt: string;
    };
    const second = (await callFunction(POST, database, OWNER, {
      workspaceId: 'ws1',
      pagesSince: first.pagesSyncedAt,
    })) as { pagesSyncedAt: string };
    expect(second.pagesSyncedAt >= first.pagesSyncedAt).toBe(true);
  });
});

describe('workspace-bootstrap concurrent-provisioning guards', () => {
  function loseRaceOnExpect(database: FakeDb, table: string, competitor: Row) {
    // Simulates the concurrent bootstrap winning between this request's read
    // and its guarded insert: the competitor row lands just before the
    // transact executes, so the `expect exists:false` guard must fire and the
    // caller must adopt the winner's row instead of inserting a duplicate.
    const originalTransact = database.transact.bind(database);
    let fired = false;
    database.transact = (async (operations: Parameters<FakeDb['transact']>[0]) => {
      if (
        !fired &&
        operations.some((op) => op.op === 'expect' && op.table === table && op.exists === false)
      ) {
        fired = true;
        if (!database.tables[table]) database.tables[table] = [];
        database.tables[table].push(competitor);
      }
      return originalTransact(operations);
    }) as FakeDb['transact'];
  }

  it('adopts the concurrently created workspace membership instead of duplicating it', async () => {
    const database = db({ workspace_members: [], pages: [pageRow('p1')] });
    loseRaceOnExpect(database, 'workspace_members', {
      id: 'wm-winner',
      workspaceId: 'ws1',
      userId: OWNER,
      role: 'owner',
      email: `${OWNER}@example.com`,
    });

    const res = (await callFunction(POST, database, OWNER, { workspaceId: 'ws1' })) as {
      currentMember?: Row;
    };
    const mine = database.tables.workspace_members.filter((member) => member.userId === OWNER);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe('wm-winner');
    expect(res.currentMember?.id).toBe('wm-winner');
  });

  it('adopts the concurrently created default organization instead of duplicating it', async () => {
    const database = db({ pages: [pageRow('p1')] });
    loseRaceOnExpect(database, 'organizations', {
      id: 'org-winner',
      name: 'Winner Org',
      ownerId: OWNER,
    });

    await callFunction(POST, database, OWNER, { workspaceId: 'ws1' });
    const mine = (database.tables.organizations ?? []).filter((org) => org.ownerId === OWNER);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe('org-winner');
    expect(database.tables.workspaces[0].organizationId).toBe('org-winner');
  });
});
