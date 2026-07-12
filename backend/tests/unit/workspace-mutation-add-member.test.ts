import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/workspace-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction } from './helpers/function-context';

// Server-level account model: adding a workspace member never sends an
// invitation email. An email addressed to an EXISTING server account is added
// directly; an email with no account is a blind no-op so the caller cannot
// probe which addresses exist. A userId can also be added directly (the admin
// picker path). There is no invitation/token/accept flow.
function ownerDb() {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: 'owner-1' }],
    workspace_members: [] as Row[],
    workspace_invitations: [] as Row[],
  });
}

function authAdminWith(users: Array<Record<string, unknown>>) {
  return {
    listUsers: async () => ({ users }),
  };
}

describe('workspace-mutation addMember (server-level accounts)', () => {
  it('adds an existing server account resolved from an email', async () => {
    const database = ownerDb();
    const res = (await callFunction(
      POST,
      database,
      'owner-1',
      { action: 'inviteMember', workspaceId: 'ws1', email: 'invitee@example.com', role: 'member' },
      { authAdmin: authAdminWith([{ id: 'user-9', email: 'invitee@example.com' }]) },
    )) as { member?: { userId?: string } };
    expect(res.member?.userId).toBe('user-9');
    expect(database.tables.workspace_members).toHaveLength(1);
    expect(database.tables.workspace_members[0].userId).toBe('user-9');
    // No invitation record is ever created.
    expect(database.tables.workspace_invitations).toHaveLength(0);
  });

  it('is a blind no-op when the email has no server account', async () => {
    const database = ownerDb();
    const res = (await callFunction(
      POST,
      database,
      'owner-1',
      { action: 'inviteMember', workspaceId: 'ws1', email: 'ghost@example.com', role: 'member' },
      { authAdmin: authAdminWith([{ id: 'user-9', email: 'someone-else@example.com' }]) },
    )) as { member?: unknown };
    // Success response, but nothing created and no member returned — a real
    // account is indistinguishable from a typo.
    expect(res).not.toBeInstanceOf(Response);
    expect(res.member).toBeUndefined();
    expect(database.tables.workspace_members).toHaveLength(0);
    expect(database.tables.workspace_invitations).toHaveLength(0);
  });

  it('adds a member directly by userId (admin picker path)', async () => {
    const database = ownerDb();
    const res = (await callFunction(POST, database, 'owner-1', {
      action: 'addMember',
      workspaceId: 'ws1',
      userId: 'user-7',
      role: 'member',
    })) as { member?: { userId?: string } };
    expect(res.member?.userId).toBe('user-7');
    expect(database.tables.workspace_members).toHaveLength(1);
    expect(database.tables.workspace_members[0].userId).toBe('user-7');
  });
});
