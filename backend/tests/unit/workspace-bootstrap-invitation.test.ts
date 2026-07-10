import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/workspace-bootstrap';
import { POST as SHARE_POST } from '../../functions/share-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner';
const INVITEE = 'invitee';

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

describe('workspace-bootstrap invitations and email shares', () => {
  it('does not auto-accept a pending workspace invitation during bootstrap', async () => {
    const database = db({
      workspace_invitations: [
        {
          id: 'inv1',
          workspaceId: 'ws1',
          email: `${INVITEE}@example.com`,
          displayName: 'Invitee',
          role: 'member',
          token: 'invite-token',
          status: 'pending',
          createdBy: OWNER,
        },
      ],
    });

    const res = await callFunction(POST, database, INVITEE, { workspaceId: 'ws1' });

    await expectErrorResponse(res, 403, 'do not have access');
    expect(database.tables.workspace_members).toHaveLength(1);
    expect(database.tables.workspace_members.some((member) => member.userId === INVITEE)).toBe(false);
    expect(database.tables.workspace_invitations[0].status).toBe('pending');
    expect(database.tables.workspace_invitations[0].acceptedBy).toBeUndefined();
  });

  it('surfaces direct email page access without creating workspace membership', async () => {
    const createdAt = '2026-07-07T00:00:00.000Z';
    const database = db({
      pages: [
        pageRow('p1', { title: 'Shared page' }),
        pageRow('db1', {
          title: 'Shared database',
          parentId: 'p1',
          parentType: 'page',
          kind: 'database',
        }),
        pageRow('row1', {
          title: 'Shared row',
          parentId: 'db1',
          parentType: 'database',
        }),
      ],
      page_permissions: [
        {
          id: 'perm-email',
          pageId: 'p1',
          workspaceId: 'ws1',
          principalType: 'email',
          principalId: `${INVITEE}@example.com`,
          label: `${INVITEE}@example.com`,
          role: 'edit',
          createdBy: OWNER,
          createdAt,
          updatedAt: createdAt,
        },
      ],
    });

    const res = (await callFunction(POST, database, INVITEE, { pageId: 'p1' })) as {
      workspace: Row;
      currentMember?: Row;
      pages: Row[];
      pageRoles: Record<string, string>;
    };

    expect(res.workspace.id).toBe('ws1');
    expect(res.currentMember).toBeUndefined();
    expect(res.pages.map((page) => page.id)).toContain('p1');
    expect(res.pages.map((page) => page.id)).toContain('db1');
    expect(res.pages.map((page) => page.id)).not.toContain('row1');
    expect(res.pageRoles.p1).toBe('edit');
    expect(res.pageRoles.db1).toBe('edit');
    expect(database.tables.workspace_members.some((member) => member.userId === INVITEE)).toBe(false);
    expect(database.tables.notifications).toHaveLength(1);
    expect(database.tables.notifications[0]).toMatchObject({
      workspaceId: 'ws1',
      userId: INVITEE,
      pageId: 'p1',
      actorId: OWNER,
      title: 'Shared page',
      target: '/p/p1',
      metadata: {
        source: 'share',
        action: 'invite',
        permissionId: 'perm-email',
        role: 'edit',
        principalType: 'email',
      },
      occurredAt: createdAt,
    });

    const rowRes = (await callFunction(POST, database, INVITEE, { pageId: 'row1' })) as {
      workspace: Row;
      currentMember?: Row;
      pages: Row[];
      pageRoles: Record<string, string>;
    };

    expect(rowRes.workspace.id).toBe('ws1');
    expect(rowRes.currentMember).toBeUndefined();
    expect(rowRes.pages.map((page) => page.id)).toEqual(expect.arrayContaining(['p1', 'db1', 'row1']));
    expect(rowRes.pageRoles.p1).toBe('edit');
    expect(rowRes.pageRoles.db1).toBe('edit');
    expect(rowRes.pageRoles.row1).toBe('edit');
  });

  it('reflects page permission role updates immediately in bootstrap roles', async () => {
    const createdAt = '2026-07-07T00:00:00.000Z';
    const database = db({
      pages: [
        pageRow('p1', { title: 'Shared page' }),
        pageRow('db1', {
          title: 'Shared database',
          parentId: 'p1',
          parentType: 'page',
          kind: 'database',
        }),
        pageRow('row1', {
          title: 'Shared row',
          parentId: 'db1',
          parentType: 'database',
        }),
      ],
      page_permissions: [
        {
          id: 'perm-user',
          pageId: 'p1',
          workspaceId: 'ws1',
          principalType: 'user',
          principalId: INVITEE,
          label: 'Invitee',
          role: 'view',
          createdBy: OWNER,
          createdAt,
          updatedAt: createdAt,
        },
      ],
    });

    for (const role of ['view', 'comment', 'edit', 'full_access']) {
      const update = await callFunction(SHARE_POST, database, OWNER, {
        action: 'updatePermission',
        permissionId: 'perm-user',
        role,
      });
      expect(update.permission.role).toBe(role);

      const res = (await callFunction(POST, database, INVITEE, { pageId: 'row1' })) as {
        currentMember?: Row;
        pageRoles: Record<string, string>;
      };
      expect(res.currentMember).toBeUndefined();
      expect(res.pageRoles.p1).toBe(role);
      expect(res.pageRoles.db1).toBe(role);
      expect(res.pageRoles.row1).toBe(role);
    }
  });
});
