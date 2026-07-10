import { describe, expect, it } from 'vitest';

import {
  assertOrganizationSharingPolicy,
  organizationSharingPolicyAllows,
  type DbRef,
} from '../../lib/org-policy';
import { fakeDb as makeFakeDb, type Row } from './helpers/fake-db';

function fakeDb(tables: Record<string, Row[]> = {}): DbRef {
  return makeFakeDb(tables) as unknown as DbRef;
}

function policyDb(sharingPolicy: Record<string, unknown> | null | undefined) {
  return fakeDb({
    workspaces: [{ id: 'ws1', organizationId: 'org1' } as Row],
    organizations: [{ id: 'org1', sharingPolicy } as Row],
  });
}

describe('organizationSharingPolicyAllows', () => {
  it('returns the fallback when there is no workspace id', async () => {
    expect(await organizationSharingPolicyAllows(fakeDb(), null, 'allowPublic')).toBe(true);
    expect(await organizationSharingPolicyAllows(fakeDb(), undefined, 'allowPublic', false)).toBe(false);
  });

  it('returns the fallback when the workspace does not exist', async () => {
    expect(await organizationSharingPolicyAllows(fakeDb(), 'ws1', 'allowPublic', false)).toBe(false);
  });

  it('returns the fallback when the workspace has no organization', async () => {
    const db = fakeDb({ workspaces: [{ id: 'ws1', organizationId: null } as Row] });
    expect(await organizationSharingPolicyAllows(db, 'ws1', 'allowPublic', false)).toBe(false);
  });

  it('returns the fallback when the organization is missing', async () => {
    const db = fakeDb({ workspaces: [{ id: 'ws1', organizationId: 'org1' } as Row], organizations: [] });
    expect(await organizationSharingPolicyAllows(db, 'ws1', 'allowPublic', false)).toBe(false);
  });

  it('returns the fallback when the policy or key is absent', async () => {
    expect(await organizationSharingPolicyAllows(policyDb(null), 'ws1', 'allowPublic', false)).toBe(false);
    expect(await organizationSharingPolicyAllows(policyDb({}), 'ws1', 'allowPublic')).toBe(true);
  });

  it('returns explicit boolean policy values', async () => {
    expect(await organizationSharingPolicyAllows(policyDb({ allowPublic: true }), 'ws1', 'allowPublic', false)).toBe(true);
    expect(await organizationSharingPolicyAllows(policyDb({ allowPublic: false }), 'ws1', 'allowPublic', true)).toBe(false);
  });

  it('ignores non-boolean policy values', async () => {
    expect(await organizationSharingPolicyAllows(policyDb({ allowPublic: 'no' }), 'ws1', 'allowPublic')).toBe(true);
    expect(await organizationSharingPolicyAllows(policyDb({ allowPublic: 0 }), 'ws1', 'allowPublic', false)).toBe(false);
  });
});

describe('assertOrganizationSharingPolicy', () => {
  it('throws the provided message when the policy denies the action', async () => {
    await expect(
      assertOrganizationSharingPolicy(policyDb({ allowPublic: false }), 'ws1', 'allowPublic', 'Sharing is disabled.'),
    ).rejects.toThrow('Sharing is disabled.');
  });

  it('resolves when the policy allows the action', async () => {
    await expect(
      assertOrganizationSharingPolicy(policyDb({ allowPublic: true }), 'ws1', 'allowPublic', 'Sharing is disabled.'),
    ).resolves.toBeUndefined();
  });

  it('honors the fallback for workspaces outside any organization', async () => {
    const db = fakeDb({ workspaces: [{ id: 'ws1', organizationId: null } as Row] });
    await expect(assertOrganizationSharingPolicy(db, 'ws1', 'allowPublic', 'Denied.')).resolves.toBeUndefined();
    await expect(assertOrganizationSharingPolicy(db, 'ws1', 'allowPublic', 'Denied.', false)).rejects.toThrow('Denied.');
  });
});
