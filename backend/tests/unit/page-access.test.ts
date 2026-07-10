import { describe, expect, it } from 'vitest';

import {
  actorPagePermissions,
  canManagePageAccess,
  maxPageShareRole,
  normalizeAccessEmail,
  pageAccessRole,
  pageHasDirectAccess,
  permissionAppliesToActor,
  workspaceMemberShareRole,
  type DbRef,
  type PageLike,
  type PagePermissionLike,
} from '../../lib/page-access';
import {
  assertActiveWorkspaceAccess,
  assertNotDeactivatedWorkspaceAccess,
} from '../../lib/org-access';
import { fakeDb as makeFakeDb, type Row } from './helpers/fake-db';

function fakeDb(tables: Record<string, Row[]>): DbRef {
  return makeFakeDb(tables) as unknown as DbRef;
}

const WORKSPACE = { id: 'ws1', ownerId: 'owner1', organizationId: null };

function baseTables(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    workspaces: [WORKSPACE as Row],
    pages: [],
    page_permissions: [],
    workspace_members: [],
    organizations: [],
    organization_members: [],
    organization_group_members: [],
    ...overrides,
  };
}

function page(id: string, extra: Partial<PageLike> = {}): PageLike {
  return { id, workspaceId: 'ws1', parentId: null, parentType: 'workspace', createdBy: 'owner1', ...extra };
}

describe('role helpers', () => {
  it('maps workspace member roles to share roles', () => {
    expect(workspaceMemberShareRole('owner')).toBe('full_access');
    expect(workspaceMemberShareRole('admin')).toBe('full_access');
    expect(workspaceMemberShareRole('member')).toBe('edit');
    expect(workspaceMemberShareRole('guest')).toBe('view');
    expect(workspaceMemberShareRole('unknown')).toBeUndefined();
    expect(workspaceMemberShareRole(null)).toBeUndefined();
  });

  it('picks the stronger of two share roles', () => {
    expect(maxPageShareRole('view', 'edit')).toBe('edit');
    expect(maxPageShareRole('full_access', 'comment')).toBe('full_access');
    expect(maxPageShareRole(undefined, 'view')).toBe('view');
    expect(maxPageShareRole('comment', undefined)).toBe('comment');
  });

  it('normalizes emails by trimming and lowercasing', () => {
    expect(normalizeAccessEmail('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(normalizeAccessEmail(42)).toBe('');
  });
});

describe('permissionAppliesToActor', () => {
  const base: PagePermissionLike = { id: 'perm1', pageId: 'p1', workspaceId: 'ws1', principalType: 'user', principalId: 'u1', role: 'view' };

  it('matches user and integration principals by id', () => {
    expect(permissionAppliesToActor(base, 'u1', new Set())).toBe(true);
    expect(permissionAppliesToActor(base, 'u2', new Set())).toBe(false);
    expect(permissionAppliesToActor({ ...base, principalType: 'integration' }, 'u1', new Set())).toBe(true);
  });

  it('matches group principals through membership', () => {
    const perm = { ...base, principalType: 'group', principalId: 'g1' };
    expect(permissionAppliesToActor(perm, 'u9', new Set(['g1']))).toBe(true);
    expect(permissionAppliesToActor(perm, 'u9', new Set(['g2']))).toBe(false);
  });

  it('matches email principals case-insensitively in both directions', () => {
    const perm = { ...base, principalType: 'email', principalId: 'Alice@Example.com' };
    expect(permissionAppliesToActor(perm, 'u9', new Set(), 'alice@example.com')).toBe(true);
    expect(permissionAppliesToActor({ ...perm, principalId: null, label: 'alice@example.com' }, 'u9', new Set(), ' ALICE@example.COM ')).toBe(true);
    expect(permissionAppliesToActor(perm, 'u9', new Set(), 'bob@example.com')).toBe(false);
    expect(permissionAppliesToActor(perm, 'u9', new Set(), undefined)).toBe(false);
  });
});

describe('pageAccessRole', () => {
  it('grants full_access to the workspace owner', async () => {
    const db = fakeDb(baseTables({ pages: [page('p1') as Row] }));
    expect(await pageAccessRole(db, page('p1'), 'owner1')).toBe('full_access');
  });

  it('fails closed for a non-member when the workspace has no owner', async () => {
    // A missing ownerId must never fabricate full_access for an arbitrary
    // authenticated caller — that would make an ownerless workspace world-
    // writable. Members still resolve through their membership role (next test).
    const db = fakeDb(baseTables({ workspaces: [{ id: 'ws1', ownerId: null } as Row] }));
    expect(await pageAccessRole(db, page('p1', { createdBy: 'someone' }), 'stranger')).toBeUndefined();
  });

  it('still resolves member roles when the workspace has no owner', async () => {
    const db = fakeDb(baseTables({
      workspaces: [{ id: 'ws1', ownerId: null } as Row],
      workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: 'member1', role: 'member' }],
    }));
    expect(await pageAccessRole(db, page('p1', { createdBy: 'someone' }), 'member1')).toBe('edit');
    expect(await pageAccessRole(db, page('p1', { createdBy: 'someone' }), 'stranger')).toBeUndefined();
  });

  it('grants edit to a page creator who is still an active member', async () => {
    const db = fakeDb(baseTables({
      // A guest member who created the page is elevated to edit by the creator
      // shortcut, proving the shortcut fires — but only for a member.
      workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: 'creator1', role: 'guest' }],
    }));
    expect(await pageAccessRole(db, page('p1', { createdBy: 'creator1' }), 'creator1')).toBe('edit');
  });

  it('denies creator-derived edit once the creator is no longer a member', async () => {
    const db = fakeDb(baseTables());
    expect(await pageAccessRole(db, page('p1', { createdBy: 'creator1' }), 'creator1')).toBeUndefined();
  });

  it('maps workspace membership roles', async () => {
    const db = fakeDb(baseTables({
      workspace_members: [
        { id: 'm1', workspaceId: 'ws1', userId: 'admin1', role: 'admin' },
        { id: 'm2', workspaceId: 'ws1', userId: 'member1', role: 'member' },
        { id: 'm3', workspaceId: 'ws1', userId: 'guest1', role: 'guest' },
      ],
    }));
    const target = page('p1', { createdBy: 'owner1' });
    expect(await pageAccessRole(db, target, 'admin1')).toBe('full_access');
    expect(await pageAccessRole(db, target, 'member1')).toBe('edit');
    expect(await pageAccessRole(db, target, 'guest1')).toBe('view');
    expect(await pageAccessRole(db, target, 'stranger')).toBeUndefined();
  });

  it('combines sources by taking the strongest role', async () => {
    const db = fakeDb(baseTables({
      workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: 'member1', role: 'member' }],
      page_permissions: [
        { id: 'pm1', pageId: 'p1', workspaceId: 'ws1', principalType: 'user', principalId: 'member1', role: 'full_access' },
      ],
      pages: [page('p1') as Row],
    }));
    expect(await pageAccessRole(db, page('p1'), 'member1')).toBe('full_access');
  });

  it('inherits permissions from ancestor pages', async () => {
    const parent = page('parent', { parentType: 'workspace' });
    const child = page('child', { parentId: 'parent', parentType: 'page', createdBy: 'owner1' });
    const db = fakeDb(baseTables({
      pages: [parent as Row, child as Row],
      page_permissions: [
        { id: 'pm1', pageId: 'parent', workspaceId: 'ws1', principalType: 'user', principalId: 'guest9', role: 'comment' },
      ],
    }));
    expect(await pageAccessRole(db, child, 'guest9')).toBe('comment');
  });

  it('stops walking at a parent cycle instead of hanging', async () => {
    const a = page('a', { parentId: 'b', parentType: 'page' });
    const b = page('b', { parentId: 'a', parentType: 'page' });
    const db = fakeDb(baseTables({ pages: [a as Row, b as Row] }));
    expect(await pageAccessRole(db, a, 'stranger')).toBeUndefined();
  });

  it('grants roles through organization group permissions', async () => {
    const db = fakeDb(baseTables({
      workspaces: [{ id: 'ws1', ownerId: 'owner1', organizationId: 'org1' } as Row],
      organizations: [{ id: 'org1', ownerId: 'owner1' } as Row],
      organization_members: [{ id: 'om1', organizationId: 'org1', userId: 'u1', status: 'active' }],
      organization_group_members: [
        { id: 'gm1', organizationId: 'org1', groupId: 'g1', organizationMemberId: 'om1', userId: 'u1' },
      ],
      page_permissions: [
        { id: 'pm1', pageId: 'p1', workspaceId: 'ws1', principalType: 'group', principalId: 'g1', role: 'edit' },
      ],
      pages: [page('p1') as Row],
    }));
    expect(await pageAccessRole(db, page('p1'), 'u1')).toBe('edit');
  });

  it('rejects deactivated organization members outright', async () => {
    const db = fakeDb(baseTables({
      workspaces: [{ id: 'ws1', ownerId: 'owner1', organizationId: 'org1' } as Row],
      organizations: [{ id: 'org1', ownerId: 'owner1' } as Row],
      organization_members: [{ id: 'om1', organizationId: 'org1', userId: 'u1', status: 'deactivated' }],
      workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: 'u1', role: 'member' }],
    }));
    await expect(pageAccessRole(db, page('p1'), 'u1')).rejects.toThrow('Organization active access required.');
  });
});

describe('pageHasDirectAccess', () => {
  it('is true for a member creator and for ancestor permissions, false otherwise', async () => {
    const parent = page('parent');
    const child = page('child', { parentId: 'parent', parentType: 'page', createdBy: 'creator1' });
    const db = fakeDb(baseTables({
      pages: [parent as Row, child as Row],
      workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: 'creator1', role: 'member' }],
      page_permissions: [
        { id: 'pm1', pageId: 'parent', workspaceId: 'ws1', principalType: 'user', principalId: 'shared1', role: 'view' },
      ],
    }));
    expect(await pageHasDirectAccess(db, child, 'creator1')).toBe(true);
    expect(await pageHasDirectAccess(db, child, 'shared1')).toBe(true);
    expect(await pageHasDirectAccess(db, child, 'stranger')).toBe(false);
  });

  it('denies a creator removed from the workspace (only surviving grants count)', async () => {
    const child = page('child', { parentType: 'workspace', createdBy: 'creator1' });
    const db = fakeDb(baseTables({ pages: [child as Row] }));
    // createdBy still matches but the creator holds no membership and no
    // direct page permission, so a remembered pageId must not grant access.
    expect(await pageHasDirectAccess(db, child, 'creator1')).toBe(false);
  });
});

describe('actorPagePermissions', () => {
  it('collects user, group, and email permissions and filters by workspace', async () => {
    const db = fakeDb(baseTables({
      organization_group_members: [
        { id: 'gm1', organizationId: 'org1', groupId: 'g1', organizationMemberId: 'om1', userId: 'u1' },
      ],
      page_permissions: [
        { id: 'pm1', pageId: 'p1', workspaceId: 'ws1', principalType: 'user', principalId: 'u1', role: 'edit' },
        { id: 'pm2', pageId: 'p2', workspaceId: 'ws1', principalType: 'group', principalId: 'g1', role: 'view' },
        { id: 'pm3', pageId: 'p3', workspaceId: 'ws1', principalType: 'email', principalId: 'u1@example.com', role: 'comment' },
        { id: 'pm4', pageId: 'p4', workspaceId: 'other', principalType: 'user', principalId: 'u1', role: 'edit' },
        { id: 'pm5', pageId: 'p5', workspaceId: 'ws1', principalType: 'user', principalId: 'u1', role: 'bogus-role' },
      ],
    }));
    const permissions = await actorPagePermissions(db, 'u1', 'ws1', 'u1@example.com');
    expect(permissions.map((permission) => permission.id).sort()).toEqual(['pm1', 'pm2', 'pm3']);
  });
});

describe('canManagePageAccess', () => {
  const workspace = { id: 'ws1', ownerId: 'owner1', organizationId: null };

  it('allows owner, member creator, and workspace admins', async () => {
    const db = fakeDb(baseTables({
      workspace_members: [
        { id: 'm1', workspaceId: 'ws1', userId: 'admin1', role: 'admin' },
        { id: 'm2', workspaceId: 'ws1', userId: 'creator1', role: 'member' },
      ],
    }));
    expect(await canManagePageAccess(db, page('p1'), workspace, 'owner1')).toBe(true);
    expect(await canManagePageAccess(db, page('p1', { createdBy: 'creator1' }), workspace, 'creator1')).toBe(true);
    expect(await canManagePageAccess(db, page('p1'), workspace, 'admin1')).toBe(true);
  });

  it('denies a page creator who has been removed from the workspace', async () => {
    const db = fakeDb(baseTables());
    expect(await canManagePageAccess(db, page('p1', { createdBy: 'creator1' }), workspace, 'creator1')).toBe(false);
  });

  it('denies plain members unless they hold full_access on the page', async () => {
    const db = fakeDb(baseTables({
      workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: 'member1', role: 'member' }],
      pages: [page('p1') as Row],
    }));
    expect(await canManagePageAccess(db, page('p1'), workspace, 'member1')).toBe(false);

    const dbWithGrant = fakeDb(baseTables({
      workspace_members: [{ id: 'm1', workspaceId: 'ws1', userId: 'member1', role: 'member' }],
      page_permissions: [
        { id: 'pm1', pageId: 'p1', workspaceId: 'ws1', principalType: 'user', principalId: 'member1', role: 'full_access' },
      ],
      pages: [page('p1') as Row],
    }));
    expect(await canManagePageAccess(dbWithGrant, page('p1'), workspace, 'member1')).toBe(true);
  });
});

describe('org-access assertions', () => {
  const orgTables = (memberStatus?: string | null, includeMember = true) => baseTables({
    workspaces: [{ id: 'ws1', ownerId: 'owner1', organizationId: 'org1' } as Row],
    organizations: [{ id: 'org1', ownerId: 'orgOwner' } as Row],
    organization_members: includeMember
      ? [{ id: 'om1', organizationId: 'org1', userId: 'u1', status: memberStatus }]
      : [],
  });

  it('assertActiveWorkspaceAccess passes org owners and active members', async () => {
    await expect(assertActiveWorkspaceAccess(fakeDb(orgTables('active')), 'ws1', 'u1')).resolves.toBeUndefined();
    await expect(assertActiveWorkspaceAccess(fakeDb(orgTables(null)), 'ws1', 'u1')).resolves.toBeUndefined();
    await expect(assertActiveWorkspaceAccess(fakeDb(orgTables('active')), 'ws1', 'orgOwner')).resolves.toBeUndefined();
  });

  it('assertActiveWorkspaceAccess rejects non-members and deactivated members', async () => {
    await expect(assertActiveWorkspaceAccess(fakeDb(orgTables('active', false)), 'ws1', 'u1')).rejects.toThrow();
    await expect(assertActiveWorkspaceAccess(fakeDb(orgTables('deactivated')), 'ws1', 'u1')).rejects.toThrow();
  });

  it('assertActiveWorkspaceAccess skips workspaces without an organization', async () => {
    await expect(assertActiveWorkspaceAccess(fakeDb(baseTables()), 'ws1', 'anyone')).resolves.toBeUndefined();
  });

  it('assertNotDeactivatedWorkspaceAccess only rejects explicit deactivation', async () => {
    await expect(assertNotDeactivatedWorkspaceAccess(fakeDb(orgTables('deactivated')), 'ws1', 'u1')).rejects.toThrow();
    await expect(assertNotDeactivatedWorkspaceAccess(fakeDb(orgTables('active')), 'ws1', 'u1')).resolves.toBeUndefined();
    await expect(assertNotDeactivatedWorkspaceAccess(fakeDb(orgTables('active', false)), 'ws1', 'u1')).resolves.toBeUndefined();
  });
});
