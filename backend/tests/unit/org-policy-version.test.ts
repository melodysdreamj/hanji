import { describe, expect, it } from 'vitest';
import { bumpOrganizationPolicyVersion, type DbRef } from '../../lib/org-policy-version';
import { POST } from '../../functions/workspace-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction } from './helpers/function-context';

const OWNER = 'owner-1';

describe('bumpOrganizationPolicyVersion', () => {
  it('creates the version row at 1 and increments on subsequent bumps', async () => {
    const database = fakeDb();
    await bumpOrganizationPolicyVersion(database as unknown as DbRef, 'org1');
    expect(database.tables.organization_policy_versions).toHaveLength(1);
    expect(database.tables.organization_policy_versions[0].version).toBe(1);

    await bumpOrganizationPolicyVersion(database as unknown as DbRef, 'org1');
    await bumpOrganizationPolicyVersion(database as unknown as DbRef, 'org1');
    expect(database.tables.organization_policy_versions).toHaveLength(1);
    expect(database.tables.organization_policy_versions[0].version).toBe(3);
  });

  it('ignores missing organization ids', async () => {
    const database = fakeDb();
    await bumpOrganizationPolicyVersion(database as unknown as DbRef, null);
    await bumpOrganizationPolicyVersion(database as unknown as DbRef, undefined);
    expect(database.tables.organization_policy_versions ?? []).toHaveLength(0);
  });
});

describe('policy-affecting mutations bump the version stamp', () => {
  it('deactivateOrganizationMember bumps the organization policy version', async () => {
    const database = fakeDb({
      organizations: [
        { id: 'org1', name: 'Org', ownerId: OWNER, workspaceCreationPolicy: 'owners_admins' },
      ],
      organization_members: [
        { id: 'om-owner', organizationId: 'org1', userId: OWNER, role: 'owner', status: 'active' },
        { id: 'om-target', organizationId: 'org1', userId: 'target-1', role: 'member', status: 'active' },
      ] as Row[],
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
      workspace_members: [{ id: 'wm-owner', workspaceId: 'ws1', userId: OWNER, role: 'owner' }] as Row[],
    });
    const res = await callFunction(POST, database, OWNER, {
      action: 'deactivateOrganizationMember',
      organizationId: 'org1',
      organizationMemberId: 'om-target',
    });
    expect(res).not.toBeInstanceOf(Response);
    expect(database.tables.organization_members.find((m) => m.id === 'om-target')?.status).toBe('deactivated');
    expect(database.tables.organization_policy_versions).toHaveLength(1);
    expect(database.tables.organization_policy_versions[0].organizationId).toBe('org1');
    expect(database.tables.organization_policy_versions[0].version).toBe(1);
  });
});
