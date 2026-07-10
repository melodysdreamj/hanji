import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/workspace-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const TARGET = 'target-1';

function removalDb() {
  return fakeDb({
    organizations: [
      { id: 'org1', name: 'Org', ownerId: OWNER, workspaceCreationPolicy: 'owners_admins' },
    ],
    organization_members: [
      { id: 'om-owner', organizationId: 'org1', userId: OWNER, role: 'owner', status: 'active', email: 'owner@example.com' },
      { id: 'om-target', organizationId: 'org1', userId: TARGET, role: 'member', status: 'active', email: 'target@example.com' },
    ],
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
    workspace_members: [
      { id: 'wm-owner', workspaceId: 'ws1', userId: OWNER, role: 'owner' },
      { id: 'wm-target', workspaceId: 'ws1', userId: TARGET, role: 'member' },
    ],
    page_permissions: [
      {
        id: 'perm-target',
        pageId: 'p1',
        workspaceId: 'ws1',
        principalType: 'user',
        principalId: TARGET,
        label: 'target@example.com',
        role: 'edit',
      },
    ],
    organization_group_members: [
      { id: 'gm-target', groupId: 'g1', organizationId: 'org1', organizationMemberId: 'om-target', userId: TARGET },
    ] as Row[],
    workspace_invitations: [
      { id: 'inv-target', workspaceId: 'ws1', email: 'target@example.com', role: 'member', status: 'pending' },
    ] as Row[],
  });
}

describe('workspace-mutation removeOrganizationMember', () => {
  it('removes memberships, permissions, invitations, and the member atomically with an audit event', async () => {
    const database = removalDb();
    const res = await callFunction(POST, database, OWNER, {
      action: 'removeOrganizationMember',
      organizationId: 'org1',
      organizationMemberId: 'om-target',
    });
    expect(res).not.toBeInstanceOf(Response);
    expect(database.tables.workspace_members.map((row) => row.id)).toEqual(['wm-owner']);
    expect(database.tables.page_permissions).toHaveLength(0);
    expect(database.tables.organization_group_members).toHaveLength(0);
    expect(database.tables.workspace_invitations[0].status).toBe('revoked');
    expect(database.tables.organization_members.map((row) => row.id)).toEqual(['om-owner']);
    const audit = database.tables.organization_audit_events ?? [];
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('organization_member.remove');
    expect((audit[0].metadata as Record<string, unknown>).removedPagePermissions).toBe(1);
  });

  it('aborts and writes nothing when the actor loses ownership mid-flight', async () => {
    const database = removalDb();
    const originalTransact = database.transact.bind(database);
    database.transact = async (operations) => {
      database.tables.organizations[0].ownerId = 'usurper-1';
      return originalTransact(operations);
    };
    const res = await callFunction(POST, database, OWNER, {
      action: 'removeOrganizationMember',
      organizationId: 'org1',
      organizationMemberId: 'om-target',
    });
    await expectErrorResponse(res, 403, 'Organization people admin access required.');
    // Stage 1 (per-workspace permission revocation) carries no guard by
    // design: over-revoking the departing member is the safe direction, and a
    // central expect cannot span the workspace-DO boundary after the split.
    expect(database.tables.page_permissions).toHaveLength(0);
    // The guarded central batch must not have run: memberships, invitations,
    // group memberships, the member row, and the audit trail stay untouched.
    expect(database.tables.workspace_members).toHaveLength(2);
    expect(database.tables.workspace_invitations[0].status).toBe('pending');
    expect(database.tables.organization_group_members).toHaveLength(1);
    expect(database.tables.organization_members).toHaveLength(2);
    expect(database.tables.organization_audit_events ?? []).toHaveLength(0);
  });

  it('refuses removal while the target still owns a workspace', async () => {
    const database = removalDb();
    database.tables.workspaces[0].ownerId = TARGET;
    const res = await callFunction(POST, database, OWNER, {
      action: 'removeOrganizationMember',
      organizationId: 'org1',
      organizationMemberId: 'om-target',
    });
    await expectErrorResponse(res, 400, 'Transfer workspace ownership');
    expect(database.tables.organization_members).toHaveLength(2);
  });
});
