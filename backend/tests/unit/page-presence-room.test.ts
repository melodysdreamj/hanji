import { describe, expect, it } from 'vitest';

import { canUsePagePresenceRoom } from '../../edgebase.config';
import { fakeDb, type Row } from './helpers/fake-db';

function roomCtx(tables: Record<string, Row[]>) {
  const db = fakeDb(tables);
  return { admin: { db: () => db } };
}

function splitRoomCtx(tables: Record<string, Row[]>) {
  const contentNames = new Set([
    'pages',
    'page_permissions',
  ]);
  const centralTables = Object.fromEntries(
    Object.entries(tables).filter(([name]) => !contentNames.has(name)),
  );
  centralTables.page_workspace_index = (tables.pages ?? []).map((page) => ({
    id: page.id,
    workspaceId: page.workspaceId,
  })) as Row[];
  const contentTables = Object.fromEntries(
    Object.entries(tables).filter(([name]) => contentNames.has(name)),
  );
  const central = fakeDb(centralTables);
  const content = fakeDb(contentTables);
  return {
    admin: {
      db(namespace: string) {
        return namespace === 'workspace' ? content : central;
      },
    },
  };
}

function baseTables(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    workspaces: [{ id: 'ws1', ownerId: 'owner1', organizationId: 'org1' } as Row],
    pages: [{ id: 'page1', workspaceId: 'ws1', parentType: 'workspace', createdBy: 'owner1' } as Row],
    workspace_members: [],
    page_permissions: [],
    organization_members: [],
    ...overrides,
  };
}

const auth = (id: string) => ({ id });

describe('canUsePagePresenceRoom', () => {
  it('routes central membership and per-workspace content tables like production', async () => {
    const ctx = splitRoomCtx(baseTables({
      page_permissions: [
        { id: 'pm1', pageId: 'page1', workspaceId: 'ws1', principalType: 'user', principalId: 'shared1', role: 'view' },
      ],
    }));

    expect(await canUsePagePresenceRoom(auth('owner1'), 'page1', ctx)).toBe(true);
    expect(await canUsePagePresenceRoom(auth('shared1'), 'page1', ctx)).toBe(true);
    expect(await canUsePagePresenceRoom(auth('stranger'), 'page1', ctx)).toBe(false);
  });

  it('rejects missing auth, unknown rooms, and trashed pages', async () => {
    const ctx = roomCtx(baseTables());
    expect(await canUsePagePresenceRoom(null, 'page1', ctx)).toBe(false);
    expect(await canUsePagePresenceRoom(auth('owner1'), 'missing', ctx)).toBe(false);
    const trashed = roomCtx(baseTables({
      pages: [{ id: 'page1', workspaceId: 'ws1', inTrash: true } as Row],
    }));
    expect(await canUsePagePresenceRoom(auth('owner1'), 'page1', trashed)).toBe(false);
  });

  it('allows the workspace owner, a member creator, and workspace members', async () => {
    const ctx = roomCtx(baseTables({
      pages: [{ id: 'page1', workspaceId: 'ws1', parentType: 'workspace', createdBy: 'creator1' } as Row],
      // The creator shortcut is gated on active membership, so creator1 is a
      // member here; a stranger (and a creator since removed) are denied.
      workspace_members: [
        { id: 'm1', workspaceId: 'ws1', userId: 'member1', role: 'member' },
        { id: 'm2', workspaceId: 'ws1', userId: 'creator1', role: 'member' },
      ],
      organization_members: [
        { id: 'om1', organizationId: 'org1', userId: 'owner1', status: 'active' },
        { id: 'om2', organizationId: 'org1', userId: 'member1', status: 'active' },
        { id: 'om3', organizationId: 'org1', userId: 'creator1', status: 'active' },
      ],
    }));
    expect(await canUsePagePresenceRoom(auth('owner1'), 'page1', ctx)).toBe(true);
    expect(await canUsePagePresenceRoom(auth('creator1'), 'page1', ctx)).toBe(true);
    expect(await canUsePagePresenceRoom(auth('member1'), 'page1', ctx)).toBe(true);
    expect(await canUsePagePresenceRoom(auth('stranger'), 'page1', ctx)).toBe(false);
  });

  it('denies a page creator who is no longer a workspace member', async () => {
    const ctx = roomCtx(baseTables({
      pages: [{ id: 'page1', workspaceId: 'ws1', parentType: 'workspace', createdBy: 'creator1' } as Row],
    }));
    expect(await canUsePagePresenceRoom(auth('creator1'), 'page1', ctx)).toBe(false);
  });

  it('allows direct page permissions found on an ancestor', async () => {
    const ctx = roomCtx(baseTables({
      pages: [
        { id: 'parent1', workspaceId: 'ws1', parentType: 'workspace' } as Row,
        { id: 'page1', workspaceId: 'ws1', parentId: 'parent1', parentType: 'page' } as Row,
      ],
      page_permissions: [
        { id: 'pm1', pageId: 'parent1', workspaceId: 'ws1', principalType: 'user', principalId: 'shared1', role: 'view' },
      ],
    }));
    expect(await canUsePagePresenceRoom(auth('shared1'), 'page1', ctx)).toBe(true);
  });

  it('allows organization-group page permissions like the mutation paths', async () => {
    // Presence now delegates to lib/page-access, so a group-granted user gets
    // presence exactly where they can already read/edit the page.
    const ctx = roomCtx(baseTables({
      page_permissions: [
        { id: 'pm-group', pageId: 'page1', workspaceId: 'ws1', principalType: 'group', principalId: 'g1', role: 'view' },
      ],
      organization_members: [
        { id: 'om1', organizationId: 'org1', userId: 'grouped1', status: 'active' },
      ],
      organization_group_members: [
        { id: 'gm1', organizationId: 'org1', groupId: 'g1', organizationMemberId: 'om1', userId: 'grouped1' },
      ],
    }));
    expect(await canUsePagePresenceRoom(auth('grouped1'), 'page1', ctx)).toBe(true);
    expect(await canUsePagePresenceRoom(auth('ungrouped1'), 'page1', ctx)).toBe(false);
  });

  it('allows direct email page permissions for the authenticated email', async () => {
    const ctx = roomCtx(baseTables({
      page_permissions: [
        {
          id: 'pm-email',
          pageId: 'page1',
          workspaceId: 'ws1',
          principalType: 'email',
          principalId: 'owner@example.com',
          role: 'edit',
        },
      ],
    }));
    expect(
      await canUsePagePresenceRoom(
        { id: 'invitee-user-id', email: 'Owner@Example.com' },
        'page1',
        ctx,
      ),
    ).toBe(true);
    expect(
      await canUsePagePresenceRoom(
        { id: 'other-user-id', email: 'other@example.com' },
        'page1',
        ctx,
      ),
    ).toBe(false);
  });

  it('denies deactivated organization members even when owner, creator, member, or shared', async () => {
    const ctx = roomCtx(baseTables({
      workspaces: [{ id: 'ws1', ownerId: 'deactivated1', organizationId: 'org1' } as Row],
      pages: [{ id: 'page1', workspaceId: 'ws1', parentType: 'workspace', createdBy: 'deactivated1' } as Row],
      workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: 'deactivated1', role: 'admin' }],
      page_permissions: [
        { id: 'pm1', pageId: 'page1', workspaceId: 'ws1', principalType: 'user', principalId: 'deactivated1', role: 'full_access' },
      ],
      organization_members: [
        { id: 'om1', organizationId: 'org1', userId: 'deactivated1', status: 'deactivated' },
      ],
    }));
    expect(await canUsePagePresenceRoom(auth('deactivated1'), 'page1', ctx)).toBe(false);
  });

  it('leaves non-organization workspaces and non-member actors unaffected', async () => {
    const noOrg = roomCtx(baseTables({
      workspaces: [{ id: 'ws1', ownerId: 'owner1', organizationId: null } as Row],
    }));
    expect(await canUsePagePresenceRoom(auth('owner1'), 'page1', noOrg)).toBe(true);

    // A workspace member who simply has no organization_members row is not
    // "deactivated" and keeps presence access.
    const nonOrgMember = roomCtx(baseTables({
      workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: 'member1', role: 'member' }],
    }));
    expect(await canUsePagePresenceRoom(auth('member1'), 'page1', nonOrgMember)).toBe(true);
  });
});
