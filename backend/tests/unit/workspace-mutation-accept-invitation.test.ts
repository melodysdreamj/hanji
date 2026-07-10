import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/workspace-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

// Regression guard: invitation acceptance must be bound to the authenticated
// account's OWN email (the session email is the account identity in the
// email+password model), never a client-supplied body.email. Any authenticated
// account holding the token/invitationId must NOT be able to redeem an invite
// addressed to a different email — including admin-role invites.
function inviteDb() {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: 'owner-1' }],
    workspace_members: [],
    workspace_invitations: [
      {
        id: 'inv1',
        workspaceId: 'ws1',
        email: 'invitee@example.com',
        role: 'admin',
        status: 'pending',
        token: 'tok-1',
      },
    ] as Row[],
  });
}

describe('workspace-mutation acceptInvitation email binding', () => {
  it('rejects an authenticated user whose session email does not match the invite', async () => {
    const database = inviteDb();
    // callFunction gives attacker-1 the session email attacker-1@example.com.
    const res = await callFunction(POST, database, 'attacker-1', {
      action: 'acceptInvitation',
      token: 'tok-1',
    });
    await expectErrorResponse(res, 400, 'Invitation email does not match.');
    expect(database.tables.workspace_members).toHaveLength(0);
    expect(database.tables.workspace_invitations[0].status).toBe('pending');
  });

  it('ignores a spoofed body.email and still binds to the session account', async () => {
    const database = inviteDb();
    const res = await callFunction(POST, database, 'attacker-1', {
      action: 'acceptInvitation',
      token: 'tok-1',
      // Spoofed: the attacker claims to be the invitee. The server must ignore
      // this and use the authenticated session email instead.
      email: 'invitee@example.com',
    });
    await expectErrorResponse(res, 400, 'Invitation email does not match.');
    expect(database.tables.workspace_members).toHaveLength(0);
  });
});
